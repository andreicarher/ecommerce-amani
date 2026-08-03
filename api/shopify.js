export default async function handler(req, res) {
  // Obtiene las variables que configuraste en Vercel
  const token = process.env.SHOPIFY_ADMIN_API_TOKEN;
  const domain = process.env.SHOPIFY_STORE_DOMAIN; // Ej: amani.myshopify.com

  if (!token || !domain) {
    return res.status(500).json({ 
      error: "Faltan las variables SHOPIFY_ADMIN_API_TOKEN o SHOPIFY_STORE_DOMAIN en Vercel." 
    });
  }

  try {
    // Petición a la API de Shopify para obtener las últimas órdenes/ventas
    const response = await fetch(`https://${domain}/admin/api/2026-01/orders.json?status=any&limit=250`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      return res.status(response.status).json({ error: `Error de Shopify: ${errorText}` });
    }

    const data = await response.json();

    // Devuelve las órdenes en formato JSON a tu reporte
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
