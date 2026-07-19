import postgres from 'postgres';

let _sql;
function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No database configured yet (DATABASE_URL is not set).');
  if (!_sql) _sql = postgres(url, { ssl: 'require', prepare: false });
  return _sql;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function table(title, rows, labelKey, valKey) {
  if (!rows.length) return '';
  const tr = rows.map(r =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(r[labelKey] || '—')}</td>
     <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;color:#c98a4b;font-weight:600">${esc(r[valKey])}</td></tr>`
  ).join('');
  return `<h3 style="font-family:Georgia,serif;font-weight:400;margin:28px 0 8px">${esc(title)}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${tr}</table>`;
}

export default async function handler(req, res) {
  // allow: Vercel cron (Bearer CRON_SECRET) or manual trigger with admin pw
  const auth = req.headers['authorization'] || '';
  const cronOk = process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;
  const pwOk = process.env.ADMIN_PW && req.query.pw === process.env.ADMIN_PW;
  if (!cronOk && !pwOk) { res.status(401).json({ error: 'unauthorized' }); return; }

  const key = process.env.RESEND_API_KEY;
  if (!key) { res.status(500).json({ error: 'RESEND_API_KEY is not set' }); return; }
  const to = process.env.REPORT_TO || 'james.highlands.art@outlook.com';

  try {
    const sql = getSql();

    const [t] = await sql`SELECT
      count(*) FILTER (WHERE event = 'pageview')::int AS visits,
      count(distinct visitor) FILTER (WHERE event = 'pageview')::int AS uniques,
      count(*) FILTER (WHERE event = 'click')::int AS clicks,
      count(*) FILTER (WHERE event = 'buy')::int AS buys,
      count(*) FILTER (WHERE event = 'search')::int AS searches
      FROM visits WHERE ts > now() - interval '7 days'`;

    const paintings = await sql`SELECT painting, count(*)::int AS c FROM visits
      WHERE event = 'click' AND painting IS NOT NULL AND ts > now() - interval '7 days'
      GROUP BY painting ORDER BY c DESC LIMIT 5`;
    const categories = await sql`SELECT initcap(category) AS category, count(*)::int AS c FROM visits
      WHERE event = 'click' AND category IS NOT NULL AND ts > now() - interval '7 days'
      GROUP BY category ORDER BY c DESC LIMIT 5`;
    const buys = await sql`SELECT painting, count(*)::int AS c FROM visits
      WHERE event = 'buy' AND painting IS NOT NULL AND ts > now() - interval '7 days'
      GROUP BY painting ORDER BY c DESC LIMIT 5`;
    const sources = await sql`SELECT
      coalesce(nullif(split_part(split_part(coalesce(referrer, ''), '://', 2), '/', 1), ''), 'direct') AS source,
      count(*)::int AS c FROM visits
      WHERE event = 'pageview' AND ts > now() - interval '7 days'
      GROUP BY source ORDER BY c DESC LIMIT 5`;
    const searches = await sql`SELECT query, count(*)::int AS c FROM visits
      WHERE event = 'search' AND query IS NOT NULL AND ts > now() - interval '7 days'
      GROUP BY query ORDER BY c DESC LIMIT 5`;
    const countries = await sql`SELECT coalesce(country,'??') AS country, count(*)::int AS c FROM visits
      WHERE event = 'pageview' AND ts > now() - interval '7 days'
      GROUP BY country ORDER BY c DESC LIMIT 5`;

    const period = new Date().toISOString().slice(0, 10);
    const stat = (label, val) =>
      `<td style="padding:14px 18px;background:#F7E7C5;border:1px solid #eadfc0;text-align:center">
        <div style="font-family:Georgia,serif;font-size:26px">${esc(val)}</div>
        <div style="font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#8a8272;margin-top:4px">${esc(label)}</div>
      </td>`;

    const html = `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#211f1c;max-width:560px;margin:0 auto;padding:24px">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin-bottom:2px">James Highlands Art</h1>
      <p style="color:#8a8272;font-size:13px;margin-top:0">Visitor report · last 7 days · ${period}</p>
      <table style="border-collapse:separate;border-spacing:6px;width:100%"><tr>
        ${stat('Visits', t.visits)}
        ${stat('Unique', t.uniques)}
        ${stat('Opens', t.clicks)}
        ${stat('Buy clicks', t.buys)}
      </tr></table>
      ${table('Top paintings (opens)', paintings, 'painting', 'c')}
      ${table('Buy intent', buys, 'painting', 'c')}
      ${table('Top categories', categories, 'category', 'c')}
      ${table('Traffic sources', sources, 'source', 'c')}
      ${table('Top searches', searches, 'query', 'c')}
      ${table('Top countries', countries, 'country', 'c')}
      <p style="margin-top:32px;font-size:12px;color:#8a8272">
        Full dashboard: <a href="https://jhart.vercel.app/api/admin" style="color:#c98a4b">jhart.vercel.app/api/admin</a> (add your password)
      </p>
    </div>`;

    const send = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'James Highlands Art <onboarding@resend.dev>',
        to: [to],
        subject: `Art site report — ${t.visits} visits, ${t.buys} buy clicks (last 7 days)`,
        html
      })
    });
    const result = await send.json();
    if (!send.ok) { res.status(502).json({ error: 'resend failed', detail: result }); return; }

    res.status(200).json({ ok: true, sent_to: to, id: result.id });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
