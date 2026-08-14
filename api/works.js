import postgres from 'postgres';

let _sql;
function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No database configured yet (DATABASE_URL is not set).');
  // prepare:false is required for Supabase's transaction pooler
  if (!_sql) _sql = postgres(url, { ssl: 'require', prepare: false });
  return _sql;
}

// Works uploaded through /api/upload live here. The 268 original paintings stay
// hardcoded in index.html; the gallery merges these in on top of them.
export async function ensureWorksTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS works (
    id SERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'landscape',
    region TEXT,
    tags TEXT,
    price TEXT NOT NULL DEFAULT '$5',
    width INT NOT NULL,
    height INT NOT NULL,
    img_url TEXT NOT NULL,
    phash TEXT,
    original_pending BOOLEAN NOT NULL DEFAULT true,
    hidden BOOLEAN NOT NULL DEFAULT false
  )`;
  await sql`ALTER TABLE works ENABLE ROW LEVEL SECURITY`;
}

export default async function handler(req, res) {
  try {
    const sql = getSql();
    await ensureWorksTable(sql);
    const rows = await sql`SELECT id, title, category, region, tags, price, width, height, img_url
      FROM works WHERE hidden = false ORDER BY created_at DESC`;
    // short cache: new uploads should show up quickly, but not every visitor
    // needs to hit the database
    res.setHeader('cache-control', 'public, max-age=30, stale-while-revalidate=300');
    res.status(200).json({ works: rows });
  } catch (e) {
    // the gallery treats any failure as "no extra works", so fail quietly
    res.status(200).json({ works: [], error: String((e && e.message) || e) });
  }
}
