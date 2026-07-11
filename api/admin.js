import postgres from 'postgres';

let _sql;
function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No database configured yet (DATABASE_URL is not set).');
  // prepare:false is required for Supabase's transaction pooler
  if (!_sql) _sql = postgres(url, { ssl: 'require', prepare: false });
  return _sql;
}

async function ensureTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS visits (
    id SERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    path TEXT,
    referrer TEXT,
    country TEXT,
    city TEXT,
    device TEXT,
    user_agent TEXT,
    visitor TEXT
  )`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS event TEXT NOT NULL DEFAULT 'pageview'`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS painting TEXT`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS category TEXT`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS query TEXT`;
  await sql`ALTER TABLE visits ENABLE ROW LEVEL SECURITY`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bars(rows, labelKey, valKey) {
  const max = Math.max(1, ...rows.map(r => Number(r[valKey])));
  return rows.map(r => {
    const pct = (Number(r[valKey]) / max) * 100;
    return `<div class="bar-row">
      <span class="bar-label">${esc(r[labelKey] || '—')}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
      <span class="bar-val">${esc(r[valKey])}</span>
    </div>`;
  }).join('');
}

export default async function handler(req, res) {
  const expected = process.env.ADMIN_PW || '';
  if (!expected || (req.query.pw || '') !== expected) {
    res.status(401).setHeader('content-type', 'text/html');
    res.send('<body style="font-family:system-ui;background:#0b0b0c;color:#ece6da;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div>401 — Unauthorized</div></body>');
    return;
  }

  try {
    const sql = getSql();
    await ensureTable(sql);

    const [totals] = await sql`SELECT
      count(*) FILTER (WHERE event = 'pageview')::int AS total,
      count(distinct visitor) FILTER (WHERE event = 'pageview')::int AS uniques,
      count(*) FILTER (WHERE event = 'pageview' AND ts::date = now()::date)::int AS today,
      count(*) FILTER (WHERE event = 'pageview' AND ts > now() - interval '7 days')::int AS week,
      count(*) FILTER (WHERE event = 'click')::int AS clicks,
      count(*) FILTER (WHERE event = 'buy')::int AS buys
      FROM visits`;

    const perDay = await sql`SELECT to_char(ts::date,'Mon DD') AS day, count(*)::int AS c
      FROM visits WHERE event = 'pageview' AND ts > now() - interval '14 days' GROUP BY ts::date ORDER BY ts::date`;
    const byCountry = await sql`SELECT coalesce(country,'??') AS country, count(*)::int AS c
      FROM visits WHERE event = 'pageview' GROUP BY country ORDER BY c DESC LIMIT 8`;
    const byDevice = await sql`SELECT coalesce(device,'?') AS device, count(*)::int AS c
      FROM visits WHERE event = 'pageview' GROUP BY device ORDER BY c DESC`;
    const byPainting = await sql`SELECT painting, count(*)::int AS c
      FROM visits WHERE event = 'click' AND painting IS NOT NULL GROUP BY painting ORDER BY c DESC LIMIT 10`;
    const byCategory = await sql`SELECT initcap(category) AS category, count(*)::int AS c
      FROM visits WHERE event = 'click' AND category IS NOT NULL GROUP BY category ORDER BY c DESC LIMIT 10`;
    const byBuy = await sql`SELECT painting, count(*)::int AS c
      FROM visits WHERE event = 'buy' AND painting IS NOT NULL GROUP BY painting ORDER BY c DESC LIMIT 10`;
    const byReferrer = await sql`SELECT
      coalesce(nullif(split_part(split_part(coalesce(referrer, ''), '://', 2), '/', 1), ''), 'direct') AS source,
      count(*)::int AS c
      FROM visits WHERE event = 'pageview' GROUP BY source ORDER BY c DESC LIMIT 8`;
    const bySearch = await sql`SELECT query, count(*)::int AS c
      FROM visits WHERE event = 'search' AND query IS NOT NULL AND query <> '' GROUP BY query ORDER BY c DESC LIMIT 10`;
    const byHour = await sql`SELECT to_char(ts, 'HH24') || ':00' AS hour, count(*)::int AS c
      FROM visits WHERE event = 'pageview' GROUP BY 1 ORDER BY 1`;
    const recent = await sql`SELECT ts, path, referrer, country, city, device, event, painting, query
      FROM visits ORDER BY ts DESC LIMIT 100`;

    const stat = (label, val) => `<div class="stat"><div class="stat-val">${esc(val)}</div><div class="stat-label">${esc(label)}</div></div>`;

    const pct = (n, d) => d > 0 ? Math.round((n / d) * 100) + '%' : '—';
    const funnelRow = (stage, num, sub) =>
      `<div class="funnel-row"><span class="funnel-stage">${stage}</span><span><span class="funnel-num">${num}</span><span class="funnel-pct">${sub}</span></span></div>`;
    const funnel =
      funnelRow('Visits', totals.total, '') +
      funnelRow('Opened a painting', totals.clicks, pct(totals.clicks, totals.total) + ' of visits') +
      funnelRow('Clicked buy', totals.buys, pct(totals.buys, totals.total) + ' of visits · ' + pct(totals.buys, totals.clicks) + ' of opens');

    const rows = recent.map(r => {
      const when = esc(new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19));
      const loc = esc([r.city, r.country].filter(Boolean).join(', ') || '—');
      let what;
      if (r.event === 'buy') what = `<span class="tag tag-buy">buy</span>${esc(r.painting || '')}`;
      else if (r.event === 'click') what = `<span class="tag tag-click">click</span>${esc(r.painting || '')}`;
      else if (r.event === 'search') what = `<span class="tag tag-search">search</span>${esc(r.query || '')}`;
      else what = `<span class="tag">view</span>${esc(r.path)}`;
      return `<tr>
        <td class="mono">${when}</td>
        <td>${what}</td>
        <td>${loc}</td>
        <td>${esc(r.device)}</td>
        <td class="ref">${esc(r.referrer || 'direct')}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>Visits — James Highlands Art</title>
<style>
  :root{--bg:#FFF2DB;--card:#F7E7C5;--ink:#211f1c;--dim:rgba(33,31,28,.6);--line:rgba(33,31,28,.15);--accent:#c98a4b;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--ink);font-family:'Helvetica Neue',Arial,sans-serif;padding:40px 5vw;}
  h1{font-family:Georgia,serif;font-weight:400;font-size:34px;margin-bottom:4px;}
  .sub{color:var(--dim);font-size:13px;margin-bottom:32px;}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:36px;}
  .stat{background:var(--card);border:1px solid var(--line);padding:22px;}
  .stat-val{font-family:Georgia,serif;font-size:38px;line-height:1;}
  .stat-label{font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);margin-top:10px;}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;margin-bottom:36px;}
  .panel{background:var(--card);border:1px solid var(--line);padding:22px;}
  .panel h2{font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);font-weight:600;margin-bottom:18px;}
  .bar-row{display:flex;align-items:center;gap:10px;margin-bottom:9px;font-size:13px;}
  .bar-label{width:120px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
  .tag{display:inline-block;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:3px;background:rgba(33,31,28,.1);color:var(--dim);margin-right:6px;}
  .tag-click{background:var(--accent);color:#fff;}
  .tag-buy{background:#2e7d32;color:#fff;}
  .tag-search{background:#5b6dc9;color:#fff;}
  .funnel-row{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px solid var(--line);}
  .funnel-row:last-child{border-bottom:none;}
  .funnel-stage{font-size:14px;}
  .funnel-num{font-family:Georgia,serif;font-size:20px;}
  .funnel-pct{font-size:12px;color:var(--dim);margin-left:8px;}
  .bar-track{flex:1;height:8px;background:rgba(33,31,28,.08);border-radius:4px;overflow:hidden;}
  .bar-fill{display:block;height:100%;background:var(--accent);}
  .bar-val{width:44px;text-align:right;flex-shrink:0;color:var(--dim);}
  table{width:100%;border-collapse:collapse;font-size:13px;}
  th{text-align:left;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);padding:10px 12px;border-bottom:1px solid var(--line);}
  td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;white-space:nowrap;}
  .ref{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dim);}
  .table-wrap{background:var(--card);border:1px solid var(--line);overflow-x:auto;}
</style></head><body>
  <h1>Visit Log</h1>
  <div class="sub">James Highlands Art · auto-refreshes every 60s · showing last ${recent.length} events</div>
  <div class="stats">
    ${stat('Total visits', totals.total)}
    ${stat('Unique visitors', totals.uniques)}
    ${stat('Today', totals.today)}
    ${stat('Last 7 days', totals.week)}
    ${stat('Painting clicks', totals.clicks)}
    ${stat('Buy clicks', totals.buys)}
  </div>
  <div class="grid">
    <div class="panel"><h2>Funnel</h2>${funnel}</div>
    <div class="panel"><h2>Buy intent (buy clicks)</h2>${bars(byBuy, 'painting', 'c') || '<div class="sub">No buy clicks yet</div>'}</div>
    <div class="panel"><h2>Traffic sources</h2>${bars(byReferrer, 'source', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Top paintings (clicks)</h2>${bars(byPainting, 'painting', 'c') || '<div class="sub">No clicks yet</div>'}</div>
    <div class="panel"><h2>Top categories (clicks)</h2>${bars(byCategory, 'category', 'c') || '<div class="sub">No clicks yet</div>'}</div>
    <div class="panel"><h2>Top searches</h2>${bars(bySearch, 'query', 'c') || '<div class="sub">No searches yet</div>'}</div>
    <div class="panel"><h2>Peak hours (UTC)</h2>${bars(byHour, 'hour', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Visits per day (14d)</h2>${bars(perDay, 'day', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Top countries</h2>${bars(byCountry, 'country', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Devices</h2>${bars(byDevice, 'device', 'c') || '<div class="sub">No data yet</div>'}</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Time (UTC)</th><th>Event</th><th>Location</th><th>Device</th><th>Referrer</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" style="color:var(--dim);padding:30px 12px">No visits recorded yet.</td></tr>'}</tbody>
    </table>
  </div>
</body></html>`;

    res.setHeader('content-type', 'text/html');
    res.status(200).send(html);
  } catch (e) {
    res.status(500).setHeader('content-type', 'text/html');
    res.send('<body style="font-family:system-ui;padding:40px"><h1>Error</h1><pre>' + esc(e && e.message || e) + '</pre></body>');
  }
}
