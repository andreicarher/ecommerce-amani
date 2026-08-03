// api/meta-creatives.js
// Trae imágenes de creativos frescas directo de Meta, usando el token del
// usuario de sistema guardado en el servidor. Se hace en dos pasos porque es
// más confiable que pedir el campo anidado "creative{...}" en una sola llamada:
//   1) ad_id -> creative_id
//   2) creative_id -> thumbnail_url / image_url
// Así, si un solo ID falla, no tumba el resto del batch.

const GRAPH_VERSION = 'v21.0';

async function fetchIds(ids, fields, token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/`);
  url.searchParams.set('ids', ids.join(','));
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const r = await fetch(url.toString());
  const data = await r.json();
  return { ok: r.ok, data };
}

module.exports = async (req, res) => {
  const TOKEN = process.env.META_ACCESS_TOKEN;

  if (!TOKEN) {
    res.status(500).json({ error: 'META_ACCESS_TOKEN no está configurado en las variables de entorno de Vercel.' });
    return;
  }

  const idsParam = String(req.query.ad_ids || '');
  const adIds = idsParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (!adIds.length) {
    res.status(400).json({ error: 'Falta el parámetro ad_ids (lista separada por comas).' });
    return;
  }
  if (adIds.length > 50) {
    res.status(400).json({ error: 'Máximo 50 ad_ids por llamada (límite de la Graph API para el parámetro ids).' });
    return;
  }
  if (!adIds.every((id) => /^\d+$/.test(id))) {
    res.status(400).json({ error: 'ad_ids debe ser una lista de IDs numéricos.' });
    return;
  }

  try {
    // Paso 1: cada ad -> su creative_id
    const step1 = await fetchIds(adIds, 'creative', TOKEN);
    if (!step1.ok || step1.data.error) {
      res.status(400).json({ error: (step1.data.error && step1.data.error.message) || 'Error consultando ads en Meta.', step: 1, raw: step1.data });
      return;
    }

    const adToCreativeId = {};
    Object.entries(step1.data).forEach(([adId, entry]) => {
      if (entry && entry.creative && entry.creative.id) adToCreativeId[adId] = entry.creative.id;
    });

    const creativeIds = [...new Set(Object.values(adToCreativeId))];
    if (!creativeIds.length) {
      res.status(200).json({}); // ningún ad tenía creative asociado — no es un error, solo vacío
      return;
    }

    // Paso 2: cada creative_id -> sus campos de imagen
    const step2 = await fetchIds(creativeIds, 'thumbnail_url,image_url,body,title', TOKEN);
    if (!step2.ok || step2.data.error) {
      res.status(400).json({ error: (step2.data.error && step2.data.error.message) || 'Error consultando creativos en Meta.', step: 2, raw: step2.data });
      return;
    }

    // Combinar: ad_id -> { creative: {...} }
    const result = {};
    Object.entries(adToCreativeId).forEach(([adId, creativeId]) => {
      const creativeData = step2.data[creativeId];
      if (creativeData && !creativeData.error) {
        result[adId] = { creative: creativeData };
      }
    });

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Error llamando a la Graph API de Meta: ' + err.message });
  }
};
