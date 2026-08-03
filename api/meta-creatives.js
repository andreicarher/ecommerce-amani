// api/meta-creatives.js
// Trae imágenes de creativos frescas directo de Meta, usando el token del
// usuario de sistema guardado en el servidor.
//
// IMPORTANTE: el parámetro "ids" para pedir varios objetos de un jalón quedó
// deprecado en v26.0+ de la Graph API ("The ids query parameter is deprecated
// in v26.0+"). Por eso aquí se pide cada objeto individualmente (en paralelo,
// no uno por uno) en vez de un solo request por lote.
//
//   Paso 1: cada ad_id -> su creative_id      (N requests en paralelo)
//   Paso 2: cada creative_id -> su imagen      (M requests en paralelo)

const GRAPH_VERSION = 'v26.0';

async function fetchOne(id, fields, token) {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${id}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', token);
  const r = await fetch(url.toString());
  const data = await r.json().catch(() => ({}));
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
    res.status(400).json({ error: 'Máximo 50 ad_ids por llamada.' });
    return;
  }
  if (!adIds.every((id) => /^\d+$/.test(id))) {
    res.status(400).json({ error: 'ad_ids debe ser una lista de IDs numéricos.' });
    return;
  }

  try {
    // Paso 1: cada ad individualmente -> su creative_id
    const step1 = await Promise.all(adIds.map((id) => fetchOne(id, 'creative', TOKEN)));

    const firstRealError = step1.find((r) => !r.ok && r.data && r.data.error);
    const adToCreativeId = {};
    adIds.forEach((adId, i) => {
      const r = step1[i];
      if (r.ok && r.data && r.data.creative && r.data.creative.id) {
        adToCreativeId[adId] = r.data.creative.id;
      }
    });

    const creativeIds = [...new Set(Object.values(adToCreativeId))];
    if (!creativeIds.length) {
      // Ningún ad tenía creative asociado. Si además el primer error real
      // existe, lo mandamos para poder diagnosticar (permisos, etc.).
      if (firstRealError) {
        res.status(400).json({ error: firstRealError.data.error.message, step: 1 });
        return;
      }
      res.status(200).json({});
      return;
    }

    // Paso 2: cada creative individualmente -> sus campos de imagen
    const step2 = await Promise.all(creativeIds.map((id) => fetchOne(id, 'thumbnail_url,image_url,body,title', TOKEN)));
    const creativeData = {};
    creativeIds.forEach((cid, i) => {
      const r = step2[i];
      if (r.ok && r.data && !r.data.error) creativeData[cid] = r.data;
    });

    const result = {};
    Object.entries(adToCreativeId).forEach(([adId, creativeId]) => {
      if (creativeData[creativeId]) result[adId] = { creative: creativeData[creativeId] };
    });

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: 'Error llamando a la Graph API de Meta: ' + err.message });
  }
};
