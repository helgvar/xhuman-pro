// Check KPI A/B treatment ponte 2/6.
// Stampa una sintesi per giorno e per tenant degli ordini + click TP, separando
// treatment (Papa, Procaccini) da control (Mandanici, Farmacri).
// Usage:
//   docker exec xhumanpro-backend node /tmp/ab_check.js
//   docker exec xhumanpro-backend node /tmp/ab_check.js 7   # ultimi 7 giorni
(async () => {
  const { pool } = require('/app/db/pool');
  const days = parseInt(process.argv[2] || '14');

  const TREATMENT = ['Papa', 'Farmacia Procaccini'];
  const CONTROL = ['Farmacia Mandanici', 'Farmacri'];

  console.log(`\n=== A/B PUSH PONTE — KPI ultimi ${days}g ===`);
  console.log(`Treatment (aggressivo + safety-net): ${TREATMENT.join(', ')}`);
  console.log(`Control (status quo): ${CONTROL.join(', ')}\n`);

  // Ordini per giorno
  const { rows: ord } = await pool.query(`
    SELECT t.name AS tenant,
      date_trunc('day', ord.order_date AT TIME ZONE 'Europe/Rome')::date AS day,
      to_char(ord.order_date AT TIME ZONE 'Europe/Rome', 'Dy') AS dow,
      COUNT(*) AS orders,
      ROUND(SUM(COALESCE(ord.grand_total_products,0))::numeric, 0) AS revenue_eur
    FROM tenants t JOIN orders ord ON ord.tenant_id=t.id
    WHERE t.name = ANY($1::text[])
      AND ord.order_date >= CURRENT_DATE - ($2 || ' days')::interval
      AND ord.order_status NOT IN ('canceled','closed')
    GROUP BY t.name, day, dow
    ORDER BY day, t.name
  `, [[...TREATMENT, ...CONTROL], String(days)]);

  // Click TP per giorno
  const { rows: clk } = await pool.query(`
    SELECT t.name AS tenant, z.fetch_date AS day,
      SUM(z.clicks) AS clicks
    FROM tenants t JOIN zombie_clicks z ON z.tenant_id=t.id
    WHERE t.name = ANY($1::text[])
      AND z.fetch_date >= CURRENT_DATE - ($2 || ' days')::interval
    GROUP BY t.name, day
  `, [[...TREATMENT, ...CONTROL], String(days)]);

  const clickMap = new Map();
  for (const r of clk) clickMap.set(`${r.tenant}|${r.day.toISOString().slice(0,10)}`, Number(r.clicks));

  console.log('Day        DOW Tenant                | Ordini  Revenue  Click TP');
  console.log('------------------------------------+-------------------------------');
  let lastDay = null;
  for (const r of ord) {
    const dayStr = r.day.toISOString().slice(0,10);
    if (dayStr !== lastDay) {
      if (lastDay) console.log('');
      lastDay = dayStr;
    }
    const isTreat = TREATMENT.includes(r.tenant);
    const tag = isTreat ? '[T]' : '[C]';
    const clicks = clickMap.get(`${r.tenant}|${dayStr}`) || 0;
    console.log(
      `${dayStr} ${r.dow} ${tag} ${r.tenant.padEnd(20)} | ${String(r.orders).padStart(6)}  €${String(r.revenue_eur).padStart(6)}  ${String(clicks).padStart(6)}`
    );
  }

  // Aggregato pre vs durante treatment (treatment iniziato dal 30/5 ~14:00 UTC)
  const treatStart = '2026-05-30';
  const { rows: agg } = await pool.query(`
    WITH ord_agg AS (
      SELECT t.name AS tenant,
        SUM(CASE WHEN ord.order_date < $1::date THEN 1 ELSE 0 END) AS ord_pre,
        SUM(CASE WHEN ord.order_date >= $1::date THEN 1 ELSE 0 END) AS ord_post,
        SUM(CASE WHEN ord.order_date < $1::date THEN COALESCE(ord.grand_total_products,0) ELSE 0 END) AS rev_pre,
        SUM(CASE WHEN ord.order_date >= $1::date THEN COALESCE(ord.grand_total_products,0) ELSE 0 END) AS rev_post,
        MIN(ord.order_date)::date AS first_day,
        MAX(ord.order_date)::date AS last_day
      FROM tenants t JOIN orders ord ON ord.tenant_id=t.id
      WHERE t.name = ANY($2::text[])
        AND ord.order_date >= CURRENT_DATE - ($3 || ' days')::interval
        AND ord.order_status NOT IN ('canceled','closed')
      GROUP BY t.name
    )
    SELECT tenant, ord_pre, ord_post, ROUND(rev_pre::numeric, 0) AS rev_pre, ROUND(rev_post::numeric, 0) AS rev_post
    FROM ord_agg ORDER BY tenant
  `, [treatStart, [...TREATMENT, ...CONTROL], String(days)]);

  console.log(`\n=== Aggregato pre (${days}g - giorno start) vs post (dal ${treatStart}) ===`);
  for (const r of agg) {
    const isTreat = TREATMENT.includes(r.tenant);
    const tag = isTreat ? '[T]' : '[C]';
    const daysPre = Math.max(1, days - 1);
    const ordPerDayPre = (Number(r.ord_pre) / daysPre).toFixed(1);
    console.log(`  ${tag} ${r.tenant.padEnd(22)} pre: ${r.ord_pre} ord / €${r.rev_pre} (${ordPerDayPre}/d) | post: ${r.ord_post} ord / €${r.rev_post}`);
  }

  // Check expires_at
  const { rows: cfg } = await pool.query(`
    SELECT t.name, hc.config_key, hc.config_value, hc.expires_at
    FROM health_config hc JOIN tenants t ON t.id=hc.tenant_id
    WHERE hc.expires_at IS NOT NULL
    ORDER BY t.name, hc.config_key
  `);
  console.log(`\n=== Config in scadenza ===`);
  for (const r of cfg) {
    const expired = new Date(r.expires_at) < new Date();
    console.log(`  ${r.name.padEnd(22)} ${r.config_key.padEnd(28)} = ${r.config_value}  ${expired ? '⚠ SCADUTO' : ''} (scade ${r.expires_at.toISOString()})`);
  }

  await pool.end();
})().catch(e => { console.error('FATAL:', e.message, e.stack); process.exit(1); });
