// api/google-ads.js
// Trae métricas de Google Ads usando el refresh token generado una sola vez
// vía OAuth Playground. El token nunca se expone al navegador.
//
// Requiere en Vercel: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
// GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID,
// y opcionalmente GOOGLE_ADS_LOGIN_CUSTOMER_ID (si se accede vía un MCC).

// Subimos la versión (v18 ya está dando 404 — probablemente Google la dio de baja).
// Además la hacemos configurable: si vuelve a pasar, se puede corregir agregando
// GOOGLE_ADS_API_VERSION en Vercel sin tener que tocar este archivo.
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v21';

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
    const body = { query, pageSize: 1000 };
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

  // Siempre pedimos por día y por campaña — el cliente agrega según necesite
  // (cuenta completa o por campaña), igual que hacemos con Meta y GA4.
  const query = `
    SELECT
      segments.date,
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${since}' AND '${until}'
  `;

  try {
    const token = await getAccessToken(CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN);
    const results = await runGAQL(CUSTOMER_ID, LOGIN_CUSTOMER_ID, token, DEV_TOKEN, query);

    const rows = results.map((r) => ({
      date: r.segments && r.segments.date,
      campaign_id: r.campaign && r.campaign.id,
      campaign_name: r.campaign && r.campaign.name,
      channel_type: r.campaign && r.campaign.advertisingChannelType,
      status: r.campaign && r.campaign.status,
      impressions: parseInt((r.metrics && r.metrics.impressions) || 0, 10),
      clicks: parseInt((r.metrics && r.metrics.clicks) || 0, 10),
      cost: parseInt((r.metrics && r.metrics.costMicros) || 0, 10) / 1e6,
      conversions: parseFloat((r.metrics && r.metrics.conversions) || 0),
      conversions_value: parseFloat((r.metrics && r.metrics.conversionsValue) || 0),
    }));

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({ since, until, rows });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando Google Ads: ' + err.message });
  }
};
