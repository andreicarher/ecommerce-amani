// api/meta-image.js
// Proxy de imágenes: descarga la imagen del CDN de Meta AQUÍ, en el servidor,
// y se la entrega al navegador desde nuestro propio dominio.
//
// Por qué existe esto: aunque la URL de Meta sea fresca y válida, el CDN de
// Facebook/Instagram bloquea que un <img src="..."> la cargue directo desde
// un dominio externo (hotlink protection). Al pedirla nosotros mismos
// server-to-server (sin navegador de por medio) ese bloqueo no aplica, y
// luego servimos los bytes desde nuestro propio dominio — ahí el navegador
// no tiene ningún problema.

module.exports = async (req, res) => {
  const imgUrl = req.query.url;

  if (!imgUrl) {
    res.status(400).json({ error: 'Falta el parámetro url.' });
    return;
  }

  let parsed;
  try {
    parsed = new URL(imgUrl);
  } catch (e) {
    res.status(400).json({ error: 'url inválida.' });
    return;
  }

  // Lista blanca de dominios — este proxy solo reenvía imágenes de Meta,
  // nunca cualquier URL arbitraria (para no volverlo un proxy abierto).
  const ALLOWED_HOST_SUFFIXES = ['.fbcdn.net', '.facebook.com', '.cdninstagram.com'];
  const hostOk = ALLOWED_HOST_SUFFIXES.some((suf) => parsed.hostname.endsWith(suf));
  if (!hostOk) {
    res.status(400).json({ error: `Dominio no permitido: ${parsed.hostname}` });
    return;
  }

  try {
    const imgRes = await fetch(imgUrl);
    if (!imgRes.ok) {
      res.status(imgRes.status).json({ error: `El CDN de Meta respondió ${imgRes.status}.` });
      return;
    }
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Error descargando la imagen: ' + err.message });
  }
};
