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

function pwOk(given) {
  const expected = process.env.ADMIN_PW || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const IG_VERSION = process.env.IG_API_VERSION || 'v25.0';

// Settings that have to survive a deploy and still be writable while running.
// Vercel's environment variables are neither, and an Instagram token has to be
// replaced every 60 days, so once it has been renewed once it lives here.
export async function ensureSettingsTable(sql) {
  await sql`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY`;
}

export async function getSetting(sql, key) {
  await ensureSettingsTable(sql);
  const [row] = await sql`SELECT value FROM app_settings WHERE key = ${key}`;
  return row ? row.value : null;
}

export async function setSetting(sql, key, value) {
  await ensureSettingsTable(sql);
  await sql`INSERT INTO app_settings (key, value, updated_at)
    VALUES (${key}, ${value}, now())
    ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = now()`;
}

// The token actually in use: the renewed one if the weekly job has ever run,
// otherwise whatever was put into the environment by hand to begin with.
export async function igToken(sql) {
  const stored = await getSetting(sql, 'ig_access_token');
  return stored || process.env.IG_ACCESS_TOKEN || null;
}

// Asks Meta what a token actually is and when it dies, rather than assuming.
// debug_token wants an app token, which is the app id and secret joined by a
// pipe; without those it will usually still answer for the token itself.
async function inspect(token) {
  const appId = process.env.IG_APP_ID;
  const secret = process.env.IG_APP_SECRET;
  const inspector = (appId && secret) ? appId + '|' + secret : token;
  let r, j;
  try {
    r = await fetch('https://graph.facebook.com/' + IG_VERSION + '/debug_token' +
      '?input_token=' + encodeURIComponent(token) +
      '&access_token=' + encodeURIComponent(inspector));
    j = await r.json();
  } catch (e) {
    return { error: 'could not reach Meta: ' + String((e && e.message) || e) };
  }
  if (!r.ok || !j || !j.data) {
    return { error: (j && j.error && j.error.message) || 'Meta would not describe the token' };
  }
  return {
    // expires_at of 0 means it never expires, which is what a Page token looks
    // like when it was taken from a long-lived user token
    neverExpires: j.data.expires_at === 0,
    expiresAt: j.data.expires_at || 0,
    valid: j.data.is_valid !== false,
    type: j.data.type || 'unknown',
  };
}

/**
 * Keeps Instagram posting working without anyone having to remember it.
 *
 * Meta hands out three kinds of token and only two of them need looking after:
 * a Page token taken from a long-lived user token never expires at all; a
 * long-lived user token lasts 60 days and is renewed by exchanging it for
 * another; an Instagram-login token lasts 60 days and has its own endpoint.
 * Rather than guess which one is in use, this asks Meta first — so on a
 * permanent token it correctly does nothing.
 */
export async function refreshIgToken(sql) {
  const token = await igToken(sql);
  if (!token) return { state: 'not-configured', note: 'No Instagram token is set.' };

  const info = await inspect(token);
  if (info.error) return { state: 'unreadable', note: info.error };
  if (!info.valid) {
    return { state: 'invalid', note: 'Meta says this token is no longer valid — it has to be replaced by hand.' };
  }
  if (info.neverExpires) {
    return { state: 'permanent', note: 'This token does not expire; nothing to renew.' };
  }

  const daysLeft = Math.round((info.expiresAt * 1000 - Date.now()) / 86400000);
  // renewing resets the full 60 days, so there is no reason to do it weekly.
  // Waiting until the last month still leaves four attempts before it lapses.
  if (daysLeft > 30) return { state: 'ok', daysLeft, note: 'Expires in ' + daysLeft + ' days.' };

  const appId = process.env.IG_APP_ID;
  const secret = process.env.IG_APP_SECRET;
  let url;
  if (appId && secret) {
    // a long-lived user token is renewed by exchanging it for another one
    url = 'https://graph.facebook.com/' + IG_VERSION + '/oauth/access_token' +
      '?grant_type=fb_exchange_token' +
      '&client_id=' + encodeURIComponent(appId) +
      '&client_secret=' + encodeURIComponent(secret) +
      '&fb_exchange_token=' + encodeURIComponent(token);
  } else {
    // no app credentials, so assume the Instagram-login flavour, which renews
    // itself using nothing but the token
    url = 'https://graph.instagram.com/refresh_access_token' +
      '?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token);
  }

  let r, j;
  try {
    r = await fetch(url);
    j = await r.json();
  } catch (e) {
    return { state: 'failed', daysLeft, note: 'Could not reach Meta: ' + String((e && e.message) || e) };
  }
  if (!r.ok || !j || !j.access_token) {
    const why = (j && j.error && j.error.message) || 'Meta refused the renewal';
    return {
      state: 'failed', daysLeft,
      note: why + (appId ? '' : ' (set IG_APP_ID and IG_APP_SECRET if this is a Facebook login token)'),
    };
  }

  await setSetting(sql, 'ig_access_token', j.access_token);
  const newDays = j.expires_in ? Math.round(j.expires_in / 86400) : 60;
  return { state: 'renewed', daysLeft: newDays, note: 'Renewed — good for another ' + newDays + ' days.' };
}

// Password-protected status, so the token can be checked without waiting for
// the weekly email — useful while first connecting the account.
export default async function handler(req, res) {
  if (!pwOk(req.query.pw)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sql = getSql();
    const token = await igToken(sql);
    const configured = !!(token && process.env.IG_USER_ID);
    const stored = await getSetting(sql, 'ig_access_token');
    const info = token ? await inspect(token) : null;

    // never return the token itself, only what can be said about it
    res.status(200).json({
      ok: true,
      configured,
      igUserIdSet: !!process.env.IG_USER_ID,
      appCredentialsSet: !!(process.env.IG_APP_ID && process.env.IG_APP_SECRET),
      tokenSource: stored ? 'renewed and stored' : (process.env.IG_ACCESS_TOKEN ? 'environment' : 'none'),
      graphVersion: IG_VERSION,
      token: info && (info.error ? { error: info.error } : {
        type: info.type,
        valid: info.valid,
        neverExpires: info.neverExpires,
        daysLeft: info.neverExpires ? null
          : Math.round((info.expiresAt * 1000 - Date.now()) / 86400000),
      }),
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
