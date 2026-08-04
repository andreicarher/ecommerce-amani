// api/shopify-sales.js
// Trae ventas por Producto, Categoría y Zona (Estado/Ciudad) directo de
// Shopify, usando el Admin API con el token guardado como variable de
// entorno (nunca se expone al navegador). Se agrega server-side para no
// mandar todas las órdenes crudas al cliente.
//
// Requiere en Vercel: SHOPIFY_STORE_DOMAIN (ej. "amani-mx.myshopify.com")
// y SHOPIFY_ADMIN_API_TOKEN (token de la app personalizada / custom app).

const API_VERSION = '2025-01'; // subir si Shopify la da de baja (igual que nos pasó con Meta)

async function shopifyGraphQL(domain, token, query, variables) {
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await r.json();
  if (!r.ok || json.errors) {
    const msg = (json.errors && json.errors.map((e) => e.message).join('; ')) || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return json.data;
}

const ORDERS_QUERY = `
  query GetOrders($cursor: String, $searchQuery: String) {
    orders(first: 100, after: $cursor, query: $searchQuery, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          createdAt
          shippingAddress { city province provinceCode countryCodeV2 }
          totalPriceSet { shopMoney { amount } }
          currentTotalPriceSet { shopMoney { amount } }
          customer { numberOfOrders }
          lineItems(first: 100) {
            edges {
              node {
                title
                quantity
                product { productType }
                originalTotalSet { shopMoney { amount } }
              }
            }
          }
        }
      }
    }
  }
`;

async function fetchAllOrders(domain, token, searchQuery) {
  let cursor = null;
  let hasNext = true;
  const orders = [];
  let pages = 0;
  while (hasNext) {
    const data = await shopifyGraphQL(domain, token, ORDERS_QUERY, { cursor, searchQuery });
    const conn = data.orders;
    conn.edges.forEach((e) => orders.push(e.node));
    hasNext = conn.pageInfo.hasNextPage;
    cursor = conn.pageInfo.endCursor;
    pages++;
    if (pages > 40) break; // tope de seguridad (~4,000 órdenes)
  }
  return orders;
}

module.exports = async (req, res) => {
  const DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
  const TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

  if (!DOMAIN || !TOKEN) {
    res.status(500).json({ error: 'SHOPIFY_STORE_DOMAIN y/o SHOPIFY_ADMIN_API_TOKEN no están configurados en Vercel.' });
    return;
  }

  const since = req.query.since; // 'YYYY-MM-DD'
  const until = req.query.until; // 'YYYY-MM-DD' (inclusive)

  let searchQuery = '-status:cancelled';
  if (since && until) {
    const untilDate = new Date(until + 'T00:00:00Z');
    untilDate.setUTCDate(untilDate.getUTCDate() + 1);
    const untilExclusive = untilDate.toISOString().slice(0, 10);
    searchQuery += ` created_at:>='${since}' created_at:<'${untilExclusive}'`;
  }

  try {
    const orders = await fetchAllOrders(DOMAIN, TOKEN, searchQuery);

    const byProduct = new Map();
    const byCategory = new Map();
    const byLocation = new Map();
    let totalRevenue = 0;

    orders.forEach((order) => {
      const addr = order.shippingAddress;
      const state = (addr && (addr.province || addr.provinceCode)) || 'Sin dato';
      const city = (addr && addr.city) || 'Sin dato';
      const locKey = `${state}|${city}`;
      if (!byLocation.has(locKey)) byLocation.set(locKey, { state, city, revenue: 0, orders: 0, quantity: 0 });
      const locEntry = byLocation.get(locKey);
      locEntry.orders += 1;

      order.lineItems.edges.forEach((li) => {
        const node = li.node;
        const product = node.title || 'Sin nombre';
        const category = (node.product && node.product.productType) || 'Sin categoría';
        const amount = parseFloat((node.originalTotalSet && node.originalTotalSet.shopMoney && node.originalTotalSet.shopMoney.amount) || 0);
        const qty = node.quantity || 0;

        totalRevenue += amount;
        locEntry.revenue += amount;
        locEntry.quantity += qty;

        if (!byProduct.has(product)) byProduct.set(product, { product, category, revenue: 0, quantity: 0, orders: new Set() });
        const pEntry = byProduct.get(product);
        pEntry.revenue += amount;
        pEntry.quantity += qty;
        pEntry.orders.add(order.id);

        if (!byCategory.has(category)) byCategory.set(category, { category, revenue: 0, quantity: 0, orders: new Set() });
        const cEntry = byCategory.get(category);
        cEntry.revenue += amount;
        cEntry.quantity += qty;
        cEntry.orders.add(order.id);
      });
    });

    const finalize = (map) => [...map.values()].map((v) => ({ ...v, orders: v.orders instanceof Set ? v.orders.size : v.orders }))
      .sort((a, b) => b.revenue - a.revenue);

    // Resumen tipo "Resumen General" — para el híbrido de esa pestaña.
    let grossTotal = 0, netTotal = 0, newCustomers = 0, newCustomersRevenue = 0, ordersWithoutCustomer = 0;
    orders.forEach((order) => {
      const gross = parseFloat((order.totalPriceSet && order.totalPriceSet.shopMoney && order.totalPriceSet.shopMoney.amount) || 0);
      const net = parseFloat((order.currentTotalPriceSet && order.currentTotalPriceSet.shopMoney && order.currentTotalPriceSet.shopMoney.amount) || 0);
      grossTotal += gross;
      netTotal += net;
      // OJO: Shopify puede regresar un objeto "customer" no-nulo pero con el
      // campo protegido "numberOfOrders" en null cuando la app no tiene
      // autorizado el acceso a datos protegidos de clientes. Por eso
      // revisamos el campo específico, no solo si "customer" existe.
      const hasCustomerData = order.customer && order.customer.numberOfOrders !== null && order.customer.numberOfOrders !== undefined;
      if (!hasCustomerData) { ordersWithoutCustomer += 1; }
      const isNew = hasCustomerData && order.customer.numberOfOrders === 1;
      if (isNew) { newCustomers += 1; newCustomersRevenue += net; }
    });
    const summary = {
      ventas_totales_shopify: grossTotal,
      ventas_netas_shopify: netTotal,
      pedidos_shopify: orders.length,
      ticket_promedio: orders.length ? netTotal / orders.length : null,
      clientes_nuevos: newCustomers,
      pct_clientes_nuevos: orders.length ? (newCustomers / orders.length * 100) : null,
      ingresos_clientes_nuevos: newCustomersRevenue,
      // diagnóstico: si esto es igual (o casi) a pedidos_shopify, probablemente falta el
      // scope "read_customers" en la app de Shopify, o son puros checkouts de invitado.
      orders_without_customer_data: ordersWithoutCustomer,
    };

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({
      since: since || null,
      until: until || null,
      total_orders: orders.length,
      total_revenue: totalRevenue,
      summary,
      by_product: finalize(byProduct),
      by_category: finalize(byCategory),
      by_location: finalize(byLocation),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando Shopify: ' + err.message });
  }
};
