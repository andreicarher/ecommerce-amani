// api/ga4-analytics.js
// Trae datos de sesiones/engagement/canal directo de Google Analytics 4,
// usando una cuenta de servicio guardada en variables de entorno de Vercel.
// El token nunca se expone al navegador.
//
// No usa ninguna librería externa (google-auth-library, etc.) — firma el JWT
// a mano con el módulo "crypto" nativo de Node, para no depender de que
// Vercel instale dependencias de npm.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(clientEmail, privateKeyRaw) {
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claimSet))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey);
  const jwt = `${signingInput}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error('OAuth error: ' + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

module.exports = async (req, res) => {
  const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
  const CLIENT_EMAIL = process.env.GA4_CLIENT_EMAIL;
  const PRIVATE_KEY = process.env.GA4_PRIVATE_KEY;

  if (!PROPERTY_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
    res.status(500).json({ error: 'Faltan GA4_PROPERTY_ID / GA4_CLIENT_EMAIL / GA4_PRIVATE_KEY en las variables de entorno de Vercel.' });
    return;
  }

  const since = req.query.since || '30daysAgo';
  const until = req.query.until || 'today';
  const metrics = String(req.query.metrics || 'sessions').split(',').map((m) => ({ name: m.trim() }));
  const dimensions = req.query.dimensions
    ? String(req.query.dimensions).split(',').map((d) => ({ name: d.trim() }))
    : [];
  const eventNames = req.query.eventNames ? String(req.query.eventNames).split(',').map((e) => e.trim()) : null;

  try {
    const token = await getAccessToken(CLIENT_EMAIL, PRIVATE_KEY);

    const body = {
      dateRanges: [{ startDate: since, endDate: until }],
      metrics,
      dimensions,
      limit: 250,
    };
    if (eventNames) {
      body.dimensionFilter = {
        filter: { fieldName: 'eventName', inListFilter: { values: eventNames } },
      };
    }

    const gaRes = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY_ID}:runReport`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await gaRes.json();

    if (!gaRes.ok || data.error) {
      res.status(400).json({ error: (data.error && data.error.message) || `HTTP ${gaRes.status}`, raw: data });
      return;
    }

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error consultando GA4: ' + err.message });
  }
};
