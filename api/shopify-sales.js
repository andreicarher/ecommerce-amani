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
          test
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
  // Consideración: un pedido cancelado no es una venta ni un cliente adquirido
  // (ya lo filtramos vía "-status:cancelled" en el query de búsqueda), y
  // tampoco lo es un pedido de PRUEBA (Bogus Gateway / modo test de Shopify)
  // — el query de búsqueda de Shopify no soporta filtrar "test" directamente,
  // así que lo excluimos aquí después de traerlo.
  return orders.filter((o) => !o.test);
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

    // ==========================================================================
    // CLIENTES NUEVOS VS RECURRENTES — lógica y consideraciones
    // ==========================================================================
    // Lógica base: un pedido es de "cliente nuevo" si es el PRIMER pedido de
    // la historia de ese cliente. Usamos customer.numberOfOrders (Admin API
    // GraphQL): si === 1, es nuevo; si es 2+, es recurrente.
    //
    // Consideración 1 — EL CONTEO ES "A DÍA DE HOY", NO "AL MOMENTO DEL PEDIDO".
    // numberOfOrders es un contador que vive en el cliente, no en el pedido —
    // refleja su total de pedidos AHORA, cuando corremos este reporte, sin
    // importar de qué mes estemos hablando. Si alguien compró en marzo y
    // volvió a comprar en junio, HOY ese cliente tiene numberOfOrders=2 — así
    // que si generamos (o regeneramos) el reporte de marzo después de junio,
    // ese pedido de marzo YA NO se ve como "nuevo", aunque en su momento sí lo
    // fue. Efecto práctico: los meses recientes son los más precisos; los
    // meses viejos SUBESTIMAN ligeramente cuántos "nuevos" hubo en su
    // momento, porque algunos de esos clientes ya volvieron a comprar desde
    // entonces. Esto no tiene arreglo sin guardar el conteo histórico
    // pedido-por-pedido (algo que Shopify no expone), así que es una
    // limitación conocida y aceptada, no un bug.
    //
    // Consideración 2 — NUNCA ASUMIMOS "RECURRENTE" CUANDO FALTA EL DATO.
    // Si numberOfOrders viene null, undefined, O EN 0 — eso es evidencia de
    // que Shopify no nos dio el dato real (por falta del permiso "Protected
    // customer data", o por checkout de invitado), NO de que el cliente sea
    // recurrente. Un pedido real, por definición, es como mínimo el pedido
    // #1 de ese cliente — un 0 es matemáticamente imposible si el pedido
    // existe, así que un 0 es tan sospechoso como un null. Estos casos se
    // cuentan aparte ("sin datos de cliente") y se EXCLUYEN del cálculo de
    // nuevos/recurrentes — nunca se cuentan como recurrentes por default.
    //
    // Consideración 3 — Ya excluimos pedidos cancelados (query de búsqueda
    // "-status:cancelled") y pedidos de prueba (filtro post-fetch por
    // order.test) antes de llegar a este punto — ninguno de los dos es una
    // venta real ni un cliente adquirido de verdad.
    //
    // Consideración 4 — El mes se asigna por order.createdAt (fecha de
    // CREACIÓN del pedido), explícitamente NO por fecha de pago ni de envío.
    let grossTotal = 0, netTotal = 0, newCustomers = 0, newCustomersRevenue = 0, ordersWithoutCustomer = 0;
    const byDay = new Map(); // 'YYYY-MM-DD' -> { ventas_totales, ventas_netas, pedidos, clientes_nuevos, ingresos_clientes_nuevos }
    orders.forEach((order) => {
      const gross = parseFloat((order.totalPriceSet && order.totalPriceSet.shopMoney && order.totalPriceSet.shopMoney.amount) || 0);
      const net = parseFloat((order.currentTotalPriceSet && order.currentTotalPriceSet.shopMoney && order.currentTotalPriceSet.shopMoney.amount) || 0);
      grossTotal += gross;
      netTotal += net;

      const n = order.customer && order.customer.numberOfOrders;
      // null/undefined = Shopify no autorizó el dato; 0 = imposible en un
      // pedido real, así que también es señal de dato faltante (ver
      // Consideración 2 arriba). Ninguno de los dos casos cuenta como
      // "recurrente" — se excluyen del cálculo por completo.
      const hasCustomerData = n !== null && n !== undefined && n > 0;
      if (!hasCustomerData) { ordersWithoutCustomer += 1; }
      const isNew = hasCustomerData && n === 1;
      if (isNew) { newCustomers += 1; newCustomersRevenue += net; }

      // Mes/día por fecha de CREACIÓN del pedido (Consideración 4) — no por
      // fecha de pago ni de envío.
      const day = (order.createdAt || '').slice(0, 10);
      if (day) {
        if (!byDay.has(day)) byDay.set(day, { date: day, ventas_totales_shopify: 0, ventas_netas_shopify: 0, pedidos_shopify: 0, clientes_nuevos: 0, ingresos_clientes_nuevos: 0 });
        const d = byDay.get(day);
        d.ventas_totales_shopify += gross;
        d.ventas_netas_shopify += net;
        d.pedidos_shopify += 1;
        if (isNew) { d.clientes_nuevos += 1; d.ingresos_clientes_nuevos += net; }
      }
    });
    const by_day = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const pctSinDatos = orders.length ? (ordersWithoutCustomer / orders.length * 100) : null;
    const summary = {
      ventas_totales_shopify: grossTotal,
      ventas_netas_shopify: netTotal,
      pedidos_shopify: orders.length,
      ticket_promedio: orders.length ? netTotal / orders.length : null,
      clientes_nuevos: newCustomers,
      // OJO: este % es sobre los pedidos CON dato de cliente, no sobre el
      // total — si hay muchos "sin datos", este % puede estar sesgado
      // (revisa pct_sin_datos_cliente antes de confiar en este número).
      pct_clientes_nuevos: orders.length ? (newCustomers / orders.length * 100) : null,
      ingresos_clientes_nuevos: newCustomersRevenue,
      // diagnóstico: cuántos pedidos no traían numberOfOrders utilizable
      // (null, undefined o 0) — probablemente falta el permiso "Protected
      // customer data" en la app de Shopify, o son puros checkouts de
      // invitado. Si pct_sin_datos_cliente es alto, los números de
      // nuevos/recurrentes de arriba son poco confiables para ese periodo.
      orders_without_customer_data: ordersWithoutCustomer,
      pct_sin_datos_cliente: pctSinDatos,
    };

    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json({
      since: since || null,
      until: until || null,
      total_orders: orders.length,
      total_revenue: totalRevenue,
      summary,
      by_day,
      by_product: finalize(byProduct),
      by_category: finalize(byCategory),
      by_location: finalize(byLocation),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error consultando Shopify: ' + err.message });
  }
};
