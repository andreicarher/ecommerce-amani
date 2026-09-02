// api/google-ads.js
// Trae métricas de Google Ads usando el refresh token generado una sola vez
// vía OAuth Playground. El token nunca se expone al navegador.
//
// Requiere en Vercel: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
// GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
// y opcionalmente GOOGLE_ADS_LOGIN_CUSTOMER_ID (si se accede vía un MCC).

// v18 y v21 ya están dadas de baja por Google (confirmado en pruebas) — v23 sí funciona.
// La dejamos configurable: si Google vuelve a dar de baja versiones, se corrige
// agregando GOOGLE_ADS_API_VERSION en Vercel sin tener que tocar este archivo.
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v23';

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Respuesta no es JSON (status ${res.status} ${res.statusText}): ${text.slice(0, 400)}`);
  }
}

async function getAccessToken(clientId, clientSecret, refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await safeJson(res);
  if (!res.ok || data.error) {
    throw new Error('OAuth error: ' + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

async function runGAQL(customerId, loginCustomerId, token, devToken, query) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'developer-token': devToken,
    'Content-Type': 'application/json',
  };
  if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

  const results = [];
  let pageToken = null;
  let pages = 0;
  do {
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${customerId}/googleAds:search`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await safeJson(res);
    if (!res.ok || data.error) {
      const errObj = data.error || (Array.isArray(data) && data[0] && data[0].error) || {};
      const baseMsg = errObj.message || `HTTP ${res.status}`;
      // Google Ads suele meter el detalle real (qué campo/valor está mal) dentro
      // de error.details — el mensaje de arriba solo dice "invalid argument"
      // sin decir de qué, así que lo incluimos completo para poder diagnosticar.
      const detailsStr = errObj.details ? ' | details: ' + JSON.stringify(errObj.details) : '';
      throw new Error(baseMsg + detailsStr);
    }
    (data.results || []).forEach((r) => results.push(r));
    pageToken = data.nextPageToken || null;
    pages++;
  } while (pageToken && pages < 20); // tope de seguridad

  return results;
}

module.exports = async (req, res) => {
  const {
    GOOGLE_ADS_DEVELOPER_TOKEN: DEV_TOKEN,
    GOOGLE_ADS_CLIENT_ID: CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: CLIENT_SECRET,
    GOOGLE_ADS_REFRESH_TOKEN: REFRESH_TOKEN,
  } = process.env;
  const CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');
  const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').replace(/-/g, '') || null;

  if (!DEV_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN || !CUSTOMER_ID) {
    res.status(500).json({ error: 'Faltan variables de entorno de Google Ads en Vercel (developer token, client id/secret, refresh token o customer id).' });
    return;
  }

  const since = req.query.since;
  const until = req.query.until;
  if (!since || !until) {
    res.status(400).json({ error: 'Faltan los parámetros since y until (YYYY-MM-DD).' });
    return;
  }
  const view = req.query.view || 'campaign';
  const dateFilter = `segments.date BETWEEN '${since}' AND '${until}'`;
  const metricsFields = `metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value`;

  const QUERIES = {
    // Base: por día, campaña y dispositivo. El cliente agrega como necesite
    // (cuenta completa, por mes, por campaña, o por dispositivo) sumando filas —
    // sumar es válido sin importar qué tan finas vengan, así que un solo query
    // alimenta el resumen, la evolución mensual, la tabla de campañas Y el
    // desglose por tipo de campaña / dispositivo.
    campaign: `
      SELECT segments.date, segments.device, campaign.id, campaign.name,
        campaign.advertising_channel_type, campaign.status, ${metricsFields}
      FROM campaign WHERE ${dateFilter}`,
    geo: `
      SELECT campaign.id, campaign.name, segments.geo_target_city, segments.geo_target_region, ${metricsFields}
      FROM geographic_view WHERE ${dateFilter}`,
    search_terms: `
      SELECT search_term_view.search_term, campaign.name, ${metricsFields}
      FROM search_term_view WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT 200`,
    keywords: `
      SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, campaign.name, ${metricsFields}
      FROM keyword_view WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT 200`,
    ads: `
      SELECT ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, campaign.name, ${metricsFields}
      FROM ad_group_ad WHERE ${dateFilter}
      ORDER BY metrics.cost_micros DESC LIMIT 100`,
    // Desglose de funnel por acción de conversión (Page View / View Item /
    // Add To Cart / Begin Checkout / Purchase) — confirmamos que este
    // desglose existe revisando la pestaña Query_GoogleAds del Sheet
    // histórico, que ya lo traía vía segments.conversion_action_name.
    // Usamos all_conversions (no "conversions" a secas) porque es la métrica
    // que efectivamente trae valores por cada acción individual — con
    // "conversions" algunas acciones pueden salir en 0 según cómo esté
    // configurada la atribución de la cuenta.
    funnel: `
      SELECT segments.date, campaign.id, campaign.name, segments.conversion_action_name,
        metrics.all_conversions, metrics.all_conversions_value
      FROM campaign WHERE ${dateFilter}`,
  };

  if (!QUERIES[view]) {
    res.status(400).json({ error: `view no soportada: ${view}. Usa: ${Object.keys(QUERIES).join(', ')}` });
    return;
  }

  try {
    const token = await getAccessToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);
    const results = await runGAQL(CUSTOMER_ID, LOGIN_CUSTOMER_ID, token, DEV_TOKEN, QUERIES[view]);

    const baseMetrics = (r) => ({
      impressions: parseInt((r.metrics && r.metrics.impressions) || 0, 10),
      clicks: parseInt((r.metrics && r.metrics.clicks) || 0, 10),
      cost: parseInt((r.metrics && r.metrics.costMicros) || 0, 10) / 1e6,
      conversions: parseFloat((r.metrics && r.metrics.conversions) || 0),
      conversions_value: parseFloat((r.metrics && r.metrics.conversionsValue) || 0),
    });

    let rows;
    if (view === 'campaign') {
      rows = results.map((r) => ({
        date: r.segments && r.segments.date,
        device: r.segments && r.segments.device,
        campaign_id: r.campaign && r.campaign.id,
        campaign_name: r.campaign && r.campaign.name,
        channel_type: r.campaign && r.campaign.advertisingChannelType,
        status: r.campaign && r.campaign.status,
        ...baseMetrics(r),
      }));
    } else if (view === 'geo') {
      // segments.geo_target_city/region vienen como "geoTargetConstants/1013962"
      // (un ID, no el nombre) — hay que resolverlos en un segundo paso.
      rows = results.map((r) => ({
        campaign_name: r.campaign && r.campaign.name,
        geo_city_id: r.segments && r.segments.geoTargetCity,
        geo_region_id: r.segments && r.segments.geoTargetRegion,
        ...baseMetrics(r),
      }));
      const ids = [...new Set(rows.flatMap((r) => [r.geo_city_id, r.geo_region_id]).filter(Boolean))];
      if (ids.length) {
        const numericIds = ids.map((id) => id.split('/').pop());
        const nameQuery = `SELECT geo_target_constant.id, geo_target_constant.name, geo_target_constant.target_type
          FROM geo_target_constant WHERE geo_target_constant.id IN (${numericIds.join(',')})`;
        try {
          const nameResults = await runGAQL(CUSTOMER_ID, LOGIN_CUSTOMER_ID, token, DEV_TOKEN, nameQuery);
          const nameMap = {};
          nameResults.forEach((r) => { nameMap[r.geoTargetConstant.id] = r.geoTargetConstant.name; });
          rows = rows.map((r) => ({
            ...r,
            geo_city: r.geo_city_id ? (nameMap[r.geo_city_id.split('/').pop()] || r.geo_city_id) : null,
            geo_region: r.geo_region_id ? (nameMap[r.geo_region_id.split('/').pop()] || r.geo_region_id) : null,
          }));
        } catch (e) {
          // si falla la resolución de nombres, seguimos con los IDs crudos en vez de tronar todo
          rows = rows.map((r) => ({ ...r, geo_city: r.geo_city_id, geo_region: r.geo_region_id }));
        }
      }
    } else if (view === 'search_terms') {
      rows = results.map((r) => ({
        search_term: r.searchTermView && r.searchTermView.searchTerm,
        campaign_name: r.campaign && r.campaign.name,
        ...baseMetrics(r),
      }));
    } else if (view === 'keywords') {
      rows = results.map((r) => ({
        keyword: r.adGroupCriterion && r.adGroupCriterion.keyword && r.adGroupCriterion.keyword.text,
        match_type: r.adGroupCriterion && r.adGroupCriterion.keyword && r.adGroupCriterion.keyword.matchType,
        campaign_name: r.campaign && r.campaign.name,
        ...baseMetrics(r),
      }));
    } else if (view === 'ads') {
      rows = results.map((r) => ({
        ad_id: r.adGroupAd && r.adGroupAd.ad && r.adGroupAd.ad.id,
        ad_name: (r.adGroupAd && r.adGroupAd.ad && r.adGroupAd.ad.name) || null,
        ad_type: r.adGroupAd && r.adGroupAd.ad && r.adGroupAd.ad.type,
        campaign_name: r.campaign && r.campaign.name,
        ...baseMetrics(r),
      }));
    } else if (view === 'funnel') {
      rows = results.map((r) => ({
        date: r.segments && r.segments.date,
        campaign_id: r.campaign && r.campaign.id,
        campaign_name: r.campaign && r.campaign.name,
        conversion_action_name: r.segments && r.segments.conversionActionName,
        all_conversions: parseFloat((r.metrics && r.metrics.allConversions) || 0),
        all_conversions_value: parseFloat((r.metrics && r.metrics.allConversionsValue) || 0),
      }));
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ since, until, view, rows });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando Google Ads: ' + err.message });
  }
};
