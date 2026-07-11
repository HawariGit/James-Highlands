import postgres from 'postgres';
import crypto from 'node:crypto';

let _sql;
function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No database configured yet (DATABASE_URL is not set).');
  // prepare:false is required for Supabase's transaction pooler
  if (!_sql) _sql = postgres(url, { ssl: 'require', prepare: false });
  return _sql;
}

let ensured = false;
async function ensureTable(sql) {
  if (ensured) return;
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
  // add event/painting columns for click tracking (migrates existing tables)
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS event TEXT NOT NULL DEFAULT 'pageview'`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS painting TEXT`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS category TEXT`;
  await sql`ALTER TABLE visits ADD COLUMN IF NOT EXISTS query TEXT`;
  // lock the table to our owner-role connection only; blocks Supabase's
  // public API (anon key). Our direct connection bypasses RLS.
  await sql`ALTER TABLE visits ENABLE ROW LEVEL SECURITY`;
  ensured = true;
}

function deviceType(ua) {
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

// crawlers, link-preview bots, monitors, and scripted HTTP clients
const BOT_RE = /bot|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|quora|pinterest|slackbot|telegram|whatsapp|discord|headless|phantomjs|python-requests|curl\/|wget|axios|go-http|node-fetch|okhttp|java\/|libwww|monitor|uptime|pingdom|lighthouse|scrapy|semrush|ahrefs|mj12bot|dotbot|dataforseo|petalbot|bytespider/i;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const ua = (req.headers['user-agent'] || '').slice(0, 400);
  // silently skip bots/scripts so they don't pollute the stats
  if (!ua || BOT_RE.test(ua)) { res.status(204).end(); return; }

  try {
    const sql = getSql();
    await ensureTable(sql);

    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const country = req.headers['x-vercel-ip-country'] || null;
    const city = req.headers['x-vercel-ip-city']
      ? decodeURIComponent(req.headers['x-vercel-ip-city'])
      : null;

    // privacy: store a one-way hash, never the raw IP
    const salt = process.env.VISITOR_SALT || 'jhart';
    const visitor = crypto.createHash('sha256').update(ip + ua + salt).digest('hex').slice(0, 16);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const path = (body.path || '/').slice(0, 300);
    const referrer = body.referrer ? String(body.referrer).slice(0, 300) : null;
    const ev = body.event;
    const event = (ev === 'click' || ev === 'buy' || ev === 'search') ? ev : 'pageview';
    const hasPiece = event === 'click' || event === 'buy';
    const painting = hasPiece && body.painting ? String(body.painting).slice(0, 200) : null;
    const category = hasPiece && body.category ? String(body.category).slice(0, 80) : null;
    const query = event === 'search' && body.query ? String(body.query).slice(0, 120) : null;

    await sql`INSERT INTO visits (path, referrer, country, city, device, user_agent, visitor, event, painting, category, query)
      VALUES (${path}, ${referrer}, ${country}, ${city}, ${deviceType(ua)}, ${ua}, ${visitor}, ${event}, ${painting}, ${category}, ${query})`;

    res.status(204).end();
  } catch (e) {
    // fail quietly so a logging hiccup never affects the visitor
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
