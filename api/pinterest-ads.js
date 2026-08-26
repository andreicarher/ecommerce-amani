// api/pinterest-ads.js
// Trae métricas de Pinterest Ads usando el token guardado en las variables de
// entorno de Vercel. El token nunca se expone al navegador.
//
// Requiere: PINTEREST_ACCESS_TOKEN
// Opcional: PINTEREST_AD_ACCOUNT_ID (si no está, la función descubre la
// primera cuenta de anuncios a la que el token tenga acceso).
//
// NOTA IMPORTANTE: esta es la primera vez que conectamos Pinterest a este
// dashboard — los nombres exactos de columnas/campos de abajo son mi mejor
// intento según la documentación de la API v5, pero (como nos pasó con
// Google Ads) es muy probable que algo necesite ajustarse en la primera
// vuelta real. Por eso esta función nunca oculta el error real de Pinterest
// — siempre lo regresa completo para poder corregir rápido.

const API_VERSION = 'v5';
const BASE_URL = `https://api.pinterest.com/${API_VERSION}`;

async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Respuesta no es JSON (status ${res.status} ${res.statusText}): ${text.slice(0, 400)}`);
  }
}

async function pinterestGet(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await safeJson(res);
  if (!res.ok || data.code) {
    // Pinterest regresa errores con forma {code, message} — los mandamos
    // completos, no un mensaje genérico.
    throw new Error((data.message || JSON.stringify(data)) + ` (status ${res.status})`);
  }
  return data;
}

async function resolveAdAccountId(token) {
  const data = await pinterestGet('/ad_accounts', token);
  const first = data.items && data.items[0];
  if (!first) throw new Error('El token no tiene acceso a ninguna cuenta de anuncios de Pinterest.');
  return first.id;
}

module.exports = async (req, res) => {
  const TOKEN = process.env.PINTEREST_ACCESS_TOKEN;
  if (!TOKEN) {
    res.status(500).json({ error: 'PINTEREST_ACCESS_TOKEN no está configurado en las variables de entorno de Vercel.' });
    return;
  }

  const since = req.query.since;
  const until = req.query.until;
  if (!since || !until) {
    res.status(400).json({ error: 'Faltan los parámetros since y until (YYYY-MM-DD).' });
    return;
  }

  try {
    let adAccountId = process.env.PINTEREST_AD_ACCOUNT_ID;
    let autoDiscovered = false;
    if (!adAccountId) {
      try {
        adAccountId = await resolveAdAccountId(TOKEN);
        autoDiscovered = true;
      } catch (e) {
        throw new Error('Falló en el paso "descubrir ad_account_id" (GET /ad_accounts): ' + e.message);
      }
    }

    // Traemos por día y por campaña (misma filosofía que Meta/Google Ads):
    // el cliente agrega como necesite (cuenta completa o por campaña).
    const columns = [
      'SPEND_IN_DOLLAR',
      'IMPRESSION_2',
      'CLICKTHROUGH_2',
      'CTR',
      'TOTAL_CONVERSIONS',
      'TOTAL_CONVERSION_VALUE_IN_MICRO_DOLLAR',
    ].join(',');

    const params = new URLSearchParams({
      start_date: since,
      end_date: until,
      columns,
      granularity: 'DAY',
      level: 'CAMPAIGN',
    });

    let analytics;
    try {
      analytics = await pinterestGet(`/ad_accounts/${adAccountId}/campaigns/analytics?${params.toString()}`, TOKEN);
    } catch (e) {
      throw new Error(`Falló en el paso "pedir analytics" (GET /ad_accounts/${adAccountId}/campaigns/analytics): ` + e.message);
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({
      since, until,
      ad_account_id: adAccountId,
      ad_account_id_auto_discovered: autoDiscovered,
      raw: analytics, // regresamos crudo mientras confirmamos la forma real de la respuesta
    });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando Pinterest Ads: ' + err.message });
  }
};
