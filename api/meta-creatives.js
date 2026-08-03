// api/meta-creatives.js
// Trae imágenes de creativos frescas directo de Meta, usando el token del
// usuario de sistema guardado en el servidor. Como se pide de nuevo cada vez
// que se carga el dashboard, la URL firmada que devuelve siempre es reciente
// — a diferencia de una URL guardada hace semanas, que ya vencida.

const GRAPH_VERSION = 'v21.0';

module.exports = async (req, res) => {
  const TOKEN = process.env.META_ACCESS_TOKEN;

  if (!TOKEN) {
    res.status(500).json({ error: 'META_ACCESS_TOKEN no está configurado en las variables de entorno de Vercel.' });
    return;
  }

  const idsParam = String(req.query.ad_ids || '');
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);

  if (!ids.length) {
    res.status(400).json({ error: 'Falta el parámetro ad_ids (lista separada por comas).' });
    return;
  }
  if (ids.length > 50) {
    res.status(400).json({ error: 'Máximo 50 ad_ids por llamada (límite de la Graph API para el parámetro ids).' });
    return;
  }
  // Solo IDs numéricos — nada de texto arbitrario llega a la Graph API.
  if (!ids.every((id) => /^\d+$/.test(id))) {
    res.status(400).json({ error: 'ad_ids debe ser una lista de IDs numéricos.' });
    return;
  }

  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/`);
  url.searchParams.set('ids', ids.join(','));
  url.searchParams.set('fields', 'creative{thumbnail_url,image_url,body,title,object_type}');
  url.searchParams.set('access_token', TOKEN);

  try {
    const metaRes = await fetch(url.toString());
    const data = await metaRes.json();

    if (data.error) {
      res.status(400).json({ error: data.error.message, code: data.error.code });
      return;
    }

    // Cache corto (30 min) — las URLs firmadas de Meta no duran para siempre,
    // así que no conviene cachear tanto como los insights.
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error llamando a la Graph API de Meta: ' + err.message });
  }
};
