import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);

async function ensureTable() {
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
  if ((req.query.pw || '') !== (process.env.ADMIN_PW || '')) {
    res.status(401).setHeader('content-type', 'text/html');
    res.send('<body style="font-family:system-ui;background:#0b0b0c;color:#ece6da;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div>401 — Unauthorized</div></body>');
    return;
  }

  try {
    await ensureTable();

    const [totals] = await sql`SELECT
      count(*)::int AS total,
      count(distinct visitor)::int AS uniques,
      count(*) FILTER (WHERE ts::date = now()::date)::int AS today,
      count(*) FILTER (WHERE ts > now() - interval '7 days')::int AS week
      FROM visits`;

    const perDay = await sql`SELECT to_char(ts::date,'Mon DD') AS day, count(*)::int AS c
      FROM visits WHERE ts > now() - interval '14 days' GROUP BY ts::date ORDER BY ts::date`;
    const byCountry = await sql`SELECT coalesce(country,'??') AS country, count(*)::int AS c
      FROM visits GROUP BY country ORDER BY c DESC LIMIT 8`;
    const byDevice = await sql`SELECT coalesce(device,'?') AS device, count(*)::int AS c
      FROM visits GROUP BY device ORDER BY c DESC`;
    const byPath = await sql`SELECT coalesce(path,'/') AS path, count(*)::int AS c
      FROM visits GROUP BY path ORDER BY c DESC LIMIT 8`;
    const recent = await sql`SELECT ts, path, referrer, country, city, device
      FROM visits ORDER BY ts DESC LIMIT 100`;

    const stat = (label, val) => `<div class="stat"><div class="stat-val">${esc(val)}</div><div class="stat-label">${esc(label)}</div></div>`;

    const rows = recent.map(r => `<tr>
      <td class="mono">${esc(new Date(r.ts).toISOString().replace('T', ' ').slice(0, 19))}</td>
      <td>${esc(r.path)}</td>
      <td>${esc([r.city, r.country].filter(Boolean).join(', ') || '—')}</td>
      <td>${esc(r.device)}</td>
      <td class="ref">${esc(r.referrer || 'direct')}</td>
    </tr>`).join('');

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
  .bar-label{width:90px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
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
  </div>
  <div class="grid">
    <div class="panel"><h2>Visits per day (14d)</h2>${bars(perDay, 'day', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Top countries</h2>${bars(byCountry, 'country', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Devices</h2>${bars(byDevice, 'device', 'c') || '<div class="sub">No data yet</div>'}</div>
    <div class="panel"><h2>Top pages</h2>${bars(byPath, 'path', 'c') || '<div class="sub">No data yet</div>'}</div>
  </div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Time (UTC)</th><th>Path</th><th>Location</th><th>Device</th><th>Referrer</th></tr></thead>
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
