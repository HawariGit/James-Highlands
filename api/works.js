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
  // painting style, kept separate from region: a Chinese ink work is not a
  // painting of China
  await sql`ALTER TABLE works ADD COLUMN IF NOT EXISTS style TEXT`;
  // true once the wordmark is burned into the stored picture. Works uploaded
  // before that change stay false and get the old CSS overlay instead.
  await sql`ALTER TABLE works ADD COLUMN IF NOT EXISTS watermarked BOOLEAN NOT NULL DEFAULT false`;
  // The full-resolution file a buyer receives. It goes straight from the browser
  // to Blob storage, so it is not bound by the 4.5MB request limit that forced
  // every earlier upload down to a 1400px web copy. Deliberately not returned by
  // the public handler below: these files are clean, unwatermarked art.
  await sql`ALTER TABLE works ADD COLUMN IF NOT EXISTS original_url TEXT`;
  // the Instagram media id, once a work has been posted. Kept so the upload page
  // can show what is already up and not offer to post it twice.
  await sql`ALTER TABLE works ADD COLUMN IF NOT EXISTS instagram_id TEXT`;
  await sql`ALTER TABLE works ENABLE ROW LEVEL SECURITY`;
}

export default async function handler(req, res) {
  try {
    const sql = getSql();
    await ensureWorksTable(sql);
    const rows = await sql`SELECT id, title, category, region, style, tags, price, width, height, img_url, watermarked
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
