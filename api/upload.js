import postgres from 'postgres';
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { put, del, head } from '@vercel/blob';
import { handleUpload } from '@vercel/blob/client';
import { ensureWorksTable } from './works.js';
import { igToken } from './instagram.js';

let _sql;
function getSql() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error('No database configured yet (DATABASE_URL is not set).');
  // prepare:false is required for Supabase's transaction pooler
  if (!_sql) _sql = postgres(url, { ssl: 'require', prepare: false });
  return _sql;
}

// constant-time compare so the password can't be guessed a character at a time
function pwOk(given) {
  const expected = process.env.ADMIN_PW || '';
  if (!expected) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const slug = (s) => String(s || 'work').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'work';

const CATEGORIES = ['mountains', 'villages', 'wadis', 'botanical', 'countryside',
  'coast', 'rivers', 'wildlife', 'cars', 'landscape', 'interior',
  'abstraction', 'nightlife', 'seafront'];
// "china" is deliberately absent: the ink-wash works are a style, not a place,
// and no painting on the site depicts China. Add it back if that changes.
const REGIONS = ['', 'oman', 'scotland', 'france', 'italy', 'uk', 'usa', 'uae'];
const STYLES = [['', '— none —'], ['chinese-ink', 'Chinese Ink']];
// suggestPrice() still proposes $5 or $10 from the file's resolution; these are
// what it can be overridden to by hand
const PRICES = ['$1', '$2', '$3', '$5', '$10'];

// What a phone or camera might label the full-size original. Some Android
// browsers hand over an empty type for HEIC, which arrives as octet-stream;
// that is allowed here because reaching this point already needs the password.
const ORIGINAL_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/tiff',
  'image/heic', 'image/heif', 'application/octet-stream'];

// A URL is only believed to be one of our originals if it looks like this.
const ORIGINAL_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/originals\//i;

// Instagram's feed only takes JPEG, between 4:5 and 1.91:1, up to 1440px wide.
// The page renders a copy that fits and parks it here just long enough for Meta
// to fetch it.
const SOCIAL_URL = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/social\//i;

// v25.0 is supported until July 2028 and is untouched by the endpoint removals
// that came with v26.0. Set IG_API_VERSION to move off it.
const IG_VERSION = process.env.IG_API_VERSION || 'v25.0';

// Meta's failures arrive nested and are often blunt. Surface the real reason
// rather than a generic failure, because the usual causes — wrong aspect ratio,
// expired token — are all things that can be acted on.
function igError(j, fallback) {
  const e = j && j.error;
  const msg = e && (e.error_user_msg || e.message);
  return msg ? (fallback + ': ' + msg) : fallback;
}

// Title suggestions. The page picks from the pool for the chosen category and
// mixes in one drawn from the picture's own colour and brightness, so the
// offered names suit what was actually uploaded. Written to sit alongside the
// existing titles rather than stand out from them.
const NAME_POOLS = {
  mountains: ['Distant Ridge', 'The High Pass', 'Peaks in Cloud', 'Above the Valley',
    'Morning on the Ridge', 'Shoulder of the Hill', 'Where the Ridges Meet',
    'The Long Ascent', 'Cloud Below the Summit', 'Blue Mountain Light'],
  villages: ['Roofs in the Morning', 'The Quiet Lane', 'Houses on the Slope',
    'Where the Path Turns', 'Doorway and Shade', 'Rooftops and Palms',
    'The Village Wall', 'Evening in the Village', 'Stone and Shadow', 'The Narrow Street'],
  wadis: ['Between the Walls', 'The Narrow Canyon', 'Water in the Gorge',
    'Shade of the Canyon', 'The Still Pool', 'Where the Wadi Bends',
    'Cool Water, High Walls', 'The Hidden Pool', 'Deep in the Gorge'],
  botanical: ['Petals and Light', 'A Single Stem', 'In the Quiet Border', 'Blossom Study',
    'Leaves in the Morning', 'The Flowering Branch', 'Wild Stems', 'Colour in the Grass',
    'Study of a Bloom'],
  countryside: ['Fields in Layers', 'The Long Furrow', 'Harvest Light',
    'Track Through the Fields', 'Hedgerow and Sky', 'The Open Field',
    'Farmland in Summer', 'Where the Fields Meet'],
  coast: ['The Tide Line', 'Rocks and Spray', 'Where the Sea Meets Stone',
    'Boats at Rest', 'Low Tide, Long Light', 'The Quiet Shore', 'Headland in Haze'],
  rivers: ['The Slow Bend', 'Reflections Downstream', 'Stones in the Shallows',
    'Where the River Widens', 'Morning on the Water', 'The Still Reach'],
  wildlife: ['Watchful', "At the Water's Edge", 'In the Long Grass', 'Stillness',
    'The Visitor', 'Among the Branches'],
  cars: ['Chrome and Shadow', 'Parked in the Sun', 'The Long Bonnet', 'Curves in Steel',
    'Waiting at the Kerb', 'Polished Lines'],
  landscape: ['Open Country', 'The Wide View', 'Light Across the Land',
    'Distance and Air', 'Under a Big Sky', 'The Far Ground'],
  interior: ['The Quiet Room', 'Light Through the Window', 'Chair and Shadow',
    'Where the Books Are', 'Morning Indoors'],
  abstraction: ['Colour Field', 'Drift', 'Soft Collision', 'Weight and Air',
    'Quiet Static', 'Fold', 'Undercurrent', 'Two Movements', 'Interruption', 'Slow Bloom'],
  nightlife: ['Neon on Wet Streets', 'After Midnight', 'The Late Window', 'Lights and Rain',
    'Closing Time', 'Signs in the Dark', 'Streetlight and Shadow', 'The Long Night',
    'Last Orders', 'City After Rain'],
  seafront: ['The Long Promenade', 'Harbour Wall', 'Boats at the Quay', 'Along the Front',
    'Where the Town Meets the Sea', 'Morning on the Harbour', 'The Sea Wall',
    'Moored for the Evening', 'Terraces Above the Bay', 'The Waterfront'],
};

const TONE_POOLS = {
  dark:   ['Last Light', 'After Dusk', 'The Blue Hour', 'Night Coming In', 'Shadow and Quiet'],
  bright: ['Full Light', 'High Summer', 'Open and Bright', 'Air and Light', 'The Pale Hour'],
  warm:   ['Warm Ground', 'Ochre and Rust', 'The Red Hour', 'Sunlit Earth'],
  gold:   ['Gold in the Grass', 'Harvest Gold', 'Late Amber', 'The Yellow Field'],
  green:  ['Deep Green', 'Green Shade', 'New Growth', 'The Green Hollow'],
  blue:   ['Cool Water', 'Blue Distance', 'Still and Blue', 'Water and Air'],
  purple: ['Lavender Light', 'Violet Hour', 'Purple Ground', 'Heather and Haze'],
};

function deny(res) {
  res.status(401).setHeader('content-type', 'text/html');
  res.send('<body style="font-family:system-ui;background:#211f1c;color:#FFF2DB;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div>401 — Unauthorized</div></body>');
}

export default async function handler(req, res) {
  // The direct-to-storage upload posts a body shaped by the Blob SDK, which has
  // nowhere to put our password, so those requests carry it in the query string
  // instead — the same way this page is opened in the first place.
  const pw = (req.method === 'POST' ? (req.body && req.body.pw) : null) || req.query.pw;
  if (!pwOk(pw)) return deny(res);

  if (req.method === 'POST') return handlePost(req, res);
  // never let a browser hold on to an old copy of this page
  res.setHeader('cache-control', 'no-store, must-revalidate');
  return res.setHeader('content-type', 'text/html').status(200).send(page(String(req.query.pw)));
}

// Looks at the painting and proposes titles for it. Every failure path returns
// ok:false rather than throwing, because the page already has pool-based names
// on screen and simply keeps them.
async function handleSuggest(body, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: false, error: 'Title suggestions are not configured.' });
  }
  const im = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
  if (!im) return res.status(400).json({ ok: false, error: 'Bad image for suggestions.' });
  const media = 'image/' + im[1];
  const data = im[2];
  if (data.length > 900000) {
    return res.status(413).json({ ok: false, error: 'Preview image too large.' });
  }

  const cat = CATEGORIES.includes(body.category) ? body.category : 'landscape';
  const taken = Array.isArray(body.taken)
    ? body.taken.filter(t => typeof t === 'string').slice(0, 400) : [];

  try {
    const anthropic = new Anthropic();
    const msg = await anthropic.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4000,
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              titles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Exactly three distinct titles for this painting.',
              },
            },
            required: ['titles'],
            additionalProperties: false,
          },
        },
      },
      system:
        'You title paintings for a watercolour gallery. Look at the painting and give three ' +
        'titles that describe what is actually in it.\n\n' +
        'House style, taken from the existing collection: "Shade of the Old Tree", ' +
        '"Mist Over the Wadi", "Still Water, Distant Peaks", "The Old Stone Bridge", ' +
        '"Watchtowers Above the Wadi", "Village on the Green Water", "Poppy Field", ' +
        '"Long Reflection", "Blossom Lane".\n\n' +
        'Rules: Title Case. Two to five words. Name what is in the picture: the subject, ' +
        'the light, the weather. No invented place names, no personal names, no dates, ' +
        'no numbering, no punctuation beyond a comma. Do not describe the medium. ' +
        'Make the three genuinely different from each other rather than rewordings.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: media, data } },
          { type: 'text', text:
            'Title this painting. It is filed under the category "' + cat + '".' +
            (taken.length
              ? '\n\nThese titles are already used in the gallery, so do not repeat any of them:\n' +
                taken.join('\n')
              : ''),
          },
        ],
      }],
    });

    if (msg.stop_reason === 'refusal') {
      return res.status(200).json({ ok: false, error: 'Could not title this image.' });
    }
    const block = msg.content.find(b => b.type === 'text');
    let titles = [];
    try { titles = JSON.parse((block && block.text) || '{}').titles || []; } catch (e) { titles = []; }
    titles = titles
      .filter(t => typeof t === 'string')
      .map(t => t.trim().replace(/["“”]/g, '').slice(0, 120))
      .filter(Boolean)
      .slice(0, 3);
    if (!titles.length) return res.status(200).json({ ok: false, error: 'No titles came back.' });
    return res.status(200).json({ ok: true, titles });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}

async function handlePost(req, res) {
  const body = req.body || {};
  try {
    // Titling needs no database — answer before opening a connection, so a
    // photo doesn't wait on the database just to be given a name.
    if (body.action === 'suggest') return await handleSuggest(body, res);

    // The full-size original never passes through this function. Vercel caps a
    // request body at 4.5MB and these files run to 40MB and beyond — that cap is
    // the whole reason earlier uploads were only ever a 1400px web copy. The
    // page now sends the original straight to Blob storage, and this branch just
    // hands out a short-lived token good for writing one file.
    if (body.type === 'blob.generate-client-token' || body.type === 'blob.upload-completed') {
      const json = await handleUpload({
        body,
        request: req,
        onBeforeGenerateToken: async () => ({
          allowedContentTypes: ORIGINAL_TYPES,
          maximumSizeInBytes: 200 * 1024 * 1024,
          addRandomSuffix: true,
        }),
        // Nothing to do on completion: the page reports the finished URL with
        // the save below, and that URL is checked against storage before it
        // reaches the row — so a work can never claim an original it lacks.
        onUploadCompleted: async () => {},
      });
      return res.status(200).json(json);
    }

    const sql = getSql();
    await ensureWorksTable(sql);

    if (body.action === 'list') {
      const rows = await sql`SELECT id, title, category, region, style, price, width, height, img_url,
        phash, original_pending, original_url, watermarked, instagram_id, created_at FROM works WHERE hidden = false ORDER BY created_at DESC`;
      return res.status(200).json({ ok: true, works: rows });
    }

    // Replaces one older upload's picture with a watermarked copy. The page
    // does the stamping (same code that marks new uploads) and sends the result
    // here; this only stores it and points the row at the new file.
    if (body.action === 'remark') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(500).json({ ok: false, error: 'Image storage is not set up.' });
      }
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'No id given.' });
      const m = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
      if (!m) return res.status(400).json({ ok: false, error: 'Image was not in a usable format.' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 4_000_000) return res.status(413).json({ ok: false, error: 'Image too large.' });

      const [row] = await sql`SELECT img_url, title FROM works WHERE id = ${id}`;
      if (!row) return res.status(404).json({ ok: false, error: 'No such painting.' });

      const name = 'uploads/' + slug(row.title) + '-' + Date.now().toString(36) +
        (m[1] === 'webp' ? '.webp' : '.jpg');
      const blob = await put(name, buf, { access: 'public', contentType: 'image/' + m[1] });
      await sql`UPDATE works SET img_url = ${blob.url}, watermarked = true WHERE id = ${id}`;
      // only drop the old file once the row points at the new one
      if (row.img_url) { try { await del(row.img_url); } catch (e) { /* already gone */ } }
      return res.status(200).json({ ok: true });
    }

    // Adds the full-size original to a painting that went up without one: every
    // upload made before this page could send big files, and any where the
    // connection dropped part way. The file reaches storage the same way as a
    // new upload; this only checks it arrived and records it against the row.
    if (body.action === 'attach-original') {
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'No id given.' });
      const cand = String(body.originalUrl || '');
      if (!ORIGINAL_URL.test(cand)) {
        return res.status(400).json({ ok: false, error: 'That is not a stored original.' });
      }
      let size = 0;
      try { const meta = await head(cand); size = (meta && meta.size) || 0; }
      catch (e) { return res.status(400).json({ ok: false, error: 'The file did not reach storage.' }); }
      if (!size) return res.status(400).json({ ok: false, error: 'The stored file is empty.' });

      const [row] = await sql`SELECT original_url FROM works WHERE id = ${id}`;
      if (!row) return res.status(404).json({ ok: false, error: 'No such painting.' });
      await sql`UPDATE works SET original_url = ${cand}, original_pending = false WHERE id = ${id}`;
      // only drop a previous original once the row points at the new one
      if (row.original_url && row.original_url !== cand) {
        try { await del(row.original_url); } catch (e) { /* already gone */ }
      }
      return res.status(200).json({ ok: true });
    }

    // Posts one painting to Instagram. The file never passes through Meta's API:
    // it is handed a public URL and fetches the picture itself, which is why the
    // page renders an Instagram-shaped JPEG into storage first. Once Instagram
    // has published it, it holds its own copy, so ours is deleted again and the
    // whole feature costs nothing in storage.
    if (body.action === 'instagram-post') {
      // the renewed token if the weekly job has ever replaced it, otherwise
      // the one set by hand in the environment
      const token = await igToken(sql);
      const igUser = process.env.IG_USER_ID;
      if (!token || !igUser) {
        return res.status(200).json({ ok: false,
          error: 'Instagram is not connected yet — IG_ACCESS_TOKEN and IG_USER_ID need setting in Vercel.' });
      }
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'No id given.' });
      const img = String(body.imageUrl || '');
      if (!SOCIAL_URL.test(img)) {
        return res.status(400).json({ ok: false, error: 'That is not a stored Instagram copy.' });
      }
      const caption = String(body.caption || '').slice(0, 2200);

      const [work] = await sql`SELECT instagram_id FROM works WHERE id = ${id}`;
      if (!work) return res.status(404).json({ ok: false, error: 'No such painting.' });
      if (work.instagram_id) {
        return res.status(200).json({ ok: false, error: 'That painting is already on Instagram.' });
      }

      const base = 'https://graph.facebook.com/' + IG_VERSION + '/' + encodeURIComponent(igUser);
      // step one: hand Meta the URL and let it pull the picture down
      const mk = await fetch(base + '/media', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ image_url: img, caption, access_token: token }),
      });
      const mkJson = await mk.json().catch(() => ({}));
      if (!mk.ok || !mkJson.id) {
        return res.status(200).json({ ok: false, error: igError(mkJson, 'Instagram would not accept the picture') });
      }

      // step two: publish the container it just built
      const pub = await fetch(base + '/media_publish', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: String(mkJson.id), access_token: token }),
      });
      const pubJson = await pub.json().catch(() => ({}));
      if (!pub.ok || !pubJson.id) {
        return res.status(200).json({ ok: false, error: igError(pubJson, 'The picture was accepted but not published') });
      }

      await sql`UPDATE works SET instagram_id = ${String(pubJson.id)} WHERE id = ${id}`;
      // Instagram serves its own copy from here on, so ours is only taking room
      try { await del(img); } catch (e) { /* already gone */ }
      return res.status(200).json({ ok: true, instagramId: String(pubJson.id) });
    }

    if (body.action === 'rename') {
      const id = parseInt(body.id, 10);
      const title = String(body.title || '').trim().slice(0, 120);
      if (!id) return res.status(400).json({ ok: false, error: 'No id given.' });
      if (!title) return res.status(400).json({ ok: false, error: 'A title is required.' });
      await sql`UPDATE works SET title = ${title} WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'delete') {
      const id = parseInt(body.id, 10);
      if (!id) return res.status(400).json({ ok: false, error: 'No id given.' });
      const [row] = await sql`SELECT img_url, original_url FROM works WHERE id = ${id}`;
      if (row && row.img_url) { try { await del(row.img_url); } catch (e) { /* blob already gone */ } }
      if (row && row.original_url) { try { await del(row.original_url); } catch (e) { /* already gone */ } }
      await sql`DELETE FROM works WHERE id = ${id}`;
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'save') {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(500).json({ ok: false, error: 'Image storage is not set up yet — see the note at the top of this page.' });
      }
      const title = String(body.title || '').trim().slice(0, 120);
      if (!title) return res.status(400).json({ ok: false, error: 'A title is required.' });

      const width = parseInt(body.width, 10) || 0;
      const height = parseInt(body.height, 10) || 0;
      if (!width || !height) return res.status(400).json({ ok: false, error: 'Missing image dimensions.' });

      // WebP where the browser can encode it, JPEG where it can't (Safari)
      const m = /^data:image\/(webp|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image || ''));
      if (!m) return res.status(400).json({ ok: false, error: 'Image was not in a format this page could convert.' });
      const fmt = m[1];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 4_000_000) return res.status(413).json({ ok: false, error: 'Display image too large.' });

      const category = CATEGORIES.includes(body.category) ? body.category : 'landscape';
      const region = REGIONS.includes(body.region) ? (body.region || null) : null;
      const style = STYLES.some(s => s[0] === body.style) ? (body.style || null) : null;
      // any whole-dollar price from $1 up; $0 and junk fall back to the cheapest
      const pm = /^\$(\d{1,3})$/.exec(String(body.price || ''));
      const price = (pm && Number(pm[1]) >= 1) ? '$' + Number(pm[1]) : PRICES[0];
      const tags = String(body.tags || '').trim().slice(0, 400) || null;
      const phash = /^[01]{64}$/.test(String(body.phash || '')) ? String(body.phash) : null;

      // The page uploads the untouched original straight to storage and hands
      // back the URL. Trust it only if the file is really there: an upload cut
      // off half way must leave the work flagged as still needing its original,
      // never quietly recorded as having one.
      let originalUrl = null;
      const cand = String(body.originalUrl || '');
      if (ORIGINAL_URL.test(cand)) {
        try {
          const meta = await head(cand);
          if (meta && meta.size > 0) originalUrl = cand;
        } catch (e) { /* not in storage — the row stays pending */ }
      }

      const name = 'uploads/' + slug(title) + '-' + Date.now().toString(36) + (fmt === 'webp' ? '.webp' : '.jpg');
      const blob = await put(name, buf, { access: 'public', contentType: 'image/' + fmt });

      const [row] = await sql`INSERT INTO works
        (title, category, region, style, tags, price, width, height, img_url, phash, watermarked,
         original_url, original_pending)
        VALUES (${title}, ${category}, ${region}, ${style}, ${tags}, ${price}, ${width}, ${height}, ${blob.url}, ${phash}, true,
         ${originalUrl}, ${!originalUrl})
        RETURNING id`;
      return res.status(200).json({ ok: true, id: row.id, url: blob.url, original: !!originalUrl });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}

// bumped by hand when this page changes, so it's possible to tell from the
// page itself whether a browser is showing an old copy
const PAGE_VERSION = 'v14';

function page(pw) {
  const needsBlob = !process.env.BLOB_READ_WRITE_TOKEN;
  const setupNote = needsBlob ? `<div class="warn setup">
    <b>Image storage isn't connected yet.</b> In the Vercel dashboard open this project →
    Storage → Create a Blob store and link it. That sets <code>BLOB_READ_WRITE_TOKEN</code>
    automatically. Uploads will fail until then.</div>` : '';

  const igReady = !!(process.env.IG_ACCESS_TOKEN && process.env.IG_USER_ID);
  const igNote = igReady ? '' : `<div class="warn setup">
    <b>Instagram posting isn't connected yet.</b> The account has to be a Professional
    account linked to a Facebook Page, and <code>IG_ACCESS_TOKEN</code> and
    <code>IG_USER_ID</code> need setting in the Vercel project settings. Until then the
    Post to Instagram buttons stay hidden.</div>`;

  const cats = CATEGORIES.map(c => '<option value="' + c + '">' + c + '</option>').join('');
  const regs = REGIONS.map(r => '<option value="' + r + '">' + (r || '— none —') + '</option>').join('');
  const stys = STYLES.map(s => '<option value="' + s[0] + '">' + s[1] + '</option>').join('');

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Add Paintings — James Highlands Art</title>
<style>
  :root{--bg:#FFF2DB;--card:#F7E7C5;--ink:#211f1c;--dim:rgba(33,31,28,.6);--line:rgba(33,31,28,.15);--accent:#c98a4b;}
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:var(--bg);color:var(--ink);font-family:'Helvetica Neue',Arial,sans-serif;padding:28px 5vw 80px;-webkit-text-size-adjust:100%;}
  h1{font-family:Georgia,serif;font-weight:400;font-size:30px;}
  .sub{color:var(--dim);font-size:13px;margin:6px 0 24px;line-height:1.5;}
  .warn{background:#fff3cd;border:1px solid #e0c98a;padding:14px;font-size:13px;line-height:1.5;margin-bottom:20px;}
  .warn.setup{background:#fde8e8;border-color:#e0a0a0;}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;background:rgba(33,31,28,.08);padding:1px 5px;}
  .pick{display:block;background:var(--card);border:2px dashed var(--line);padding:34px 20px;text-align:center;
    cursor:pointer;font-size:15px;margin-bottom:24px;}
  .pick:active{background:#f0dcb4;}
  /* not display:none — some mobile browsers refuse to open a file input that
     has been removed from the layout, even via a label[for] */
  input[type=file]{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}
  .card{background:var(--card);border:1px solid var(--line);padding:16px;margin-bottom:16px;display:grid;
    grid-template-columns:112px 1fr;gap:16px;align-items:start;}
  .thumbs{display:flex;flex-direction:column;gap:8px;}
  .thumb{width:112px;height:112px;object-fit:cover;background:#fff;border:1px solid var(--line);display:block;}
  .corner{width:112px;height:56px;object-fit:none;background:#fff;border:1px solid var(--line);display:block;}
  .corner-lbl{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);text-align:center;}
  label{display:block;font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--dim);margin:10px 0 4px;}
  input[type=text],select{width:100%;padding:9px 10px;border:1px solid var(--line);background:#fff;
    font-family:inherit;font-size:15px;color:var(--ink);}
  .row{display:flex;gap:10px;}
  .row>div{flex:1;min-width:0;}
  .meta{font-size:12px;color:var(--dim);margin-top:8px;line-height:1.5;}
  .dupe{background:#fde8e8;border:1px solid #e0a0a0;padding:8px 10px;font-size:12px;margin-top:8px;}
  .btn{background:var(--ink);color:var(--bg);border:none;padding:14px 22px;font-family:inherit;font-size:15px;
    cursor:pointer;letter-spacing:.04em;}
  .btn:disabled{opacity:.45;cursor:default;}
  .btn.ghost{background:none;color:var(--dim);border:1px solid var(--line);padding:7px 13px;font-size:12px;}
  .bar{position:sticky;bottom:0;background:var(--bg);padding:16px 0;border-top:1px solid var(--line);
    display:flex;gap:12px;align-items:center;}
  .status{font-size:13px;color:var(--dim);}
  h2{font-family:Georgia,serif;font-weight:400;font-size:21px;margin:40px 0 6px;}
  .live{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);
    padding:10px;margin-bottom:8px;font-size:14px;}
  .live img{width:52px;height:52px;object-fit:cover;background:#fff;flex-shrink:0;}
  .live .g{flex:1;min-width:0;}
  .live .t{width:100%;padding:5px 7px;border:1px solid transparent;background:none;
    font-family:inherit;font-size:14px;color:var(--ink);}
  .live .t:hover{border-color:var(--line);background:#fff;}
  .live .t:focus{border-color:var(--accent);background:#fff;outline:none;}
  input.needed{border-color:#c0392b;background:#fff6f5;}
  .sugg{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;}
  .sugg button{font-family:Georgia,serif;font-size:13px;padding:6px 10px;cursor:pointer;
    border:1px solid var(--line);background:#fff;color:var(--ink);}
  .sugg button:hover{border-color:var(--accent);color:var(--accent);}
  .sugg button.more{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;
    letter-spacing:.08em;text-transform:uppercase;color:var(--dim);background:none;}
  .sugg .titling{align-self:center;font-size:11px;color:var(--dim);font-style:italic;}
  .remark{background:#fff3cd;border:1px solid #e0c98a;padding:14px;margin:26px 0 0;font-size:13px;line-height:1.5;}
  .remark b{display:block;margin-bottom:4px;}
  .remark .btn{margin-top:10px;}
  .remark .prog{margin-top:8px;font-size:12px;color:var(--dim);}
  .live .d{font-size:11px;color:var(--dim);margin-top:2px;}
  .live .btn{flex-shrink:0;}
  .pending{display:inline-block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;background:var(--accent);
    color:#fff;padding:2px 6px;margin-left:6px;}
  @media(max-width:560px){ .card{grid-template-columns:1fr;} .thumbs{flex-direction:row;} .thumb,.corner{width:50%;height:96px;} }
</style></head><body>
<h1>Add Paintings</h1>
<div class="sub">Pick photos, check each one, then publish. They appear on the site straight away.
  &nbsp;<span style="opacity:.5">${PAGE_VERSION}</span></div>
${setupNote}
${igNote}
<div class="warn">
  <b>Before publishing, check the corner preview on each photo.</b> It shows the bottom-right
  of the image magnified — that is where AI tools put their watermark. Anything with a
  watermark should not go on the site. Duplicates of paintings already uploaded are flagged
  automatically.
</div>

<label class="pick" for="files">📷 &nbsp;Tap to choose photos</label>
<input type="file" id="files" accept="image/*" multiple>

<div class="warn" id="msg" style="display:none"></div>
<div id="staged"></div>

<div class="bar" id="bar" style="display:none">
  <button class="btn" id="publish">Publish</button>
  <span class="status" id="status"></span>
</div>

<div id="remarkPanel" style="display:none"></div>

<h2>Already on the site</h2>
<div class="sub">Uploaded through this page. Deleting removes it from the site immediately.</div>
<div id="live"></div>

<script>
var PW = ${JSON.stringify(pw)};
var PRICES = ${JSON.stringify(PRICES)};
var NAME_POOLS = ${JSON.stringify(NAME_POOLS)};
var TONE_POOLS = ${JSON.stringify(TONE_POOLS)};
var IG_READY = ${igReady};
var MAX = 1400;              // display copies are capped at 1400px, same as the rest of the site
var MIN_DPI = 170;           // matches the gallery: no soft or stretched prints
var A3 = [11.69, 16.54];
var staged = [];
var existingHashes = [];

// The Blob SDK's browser build, bundled once into /blob-client.js. This is what
// lets a 40MB photo reach storage at all: it splits the file into parts, sends
// them in parallel and retries the ones that fail, which is what a phone on
// mobile data needs. If it will not load, publishing still works — the painting
// goes up without its original and is marked as needing one.
var blobUpload = null;
import('/blob-client.js')
  .then(function(m){ blobUpload = m.upload; })
  .catch(function(){ blobUpload = null; });

function el(tag, cls, txt){ var e = document.createElement(tag); if(cls) e.className = cls; if(txt != null) e.textContent = txt; return e; }
// the status line lives in a bar that is hidden while nothing is staged, so
// anything that goes wrong before then has to be reported here instead
function say(text){
  var m = document.getElementById('msg');
  m.textContent = text || '';
  m.style.display = text ? 'block' : 'none';
}
function post(payload){
  payload.pw = PW;
  return fetch(location.pathname, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
    .then(function(r){
      // errors from the platform itself (size limits, timeouts) come back as
      // HTML, so read as text first and report something useful either way
      return r.text().then(function(t){
        try { return JSON.parse(t); }
        catch(e){ return {ok:false, error:'server replied ' + r.status + ' — ' + t.slice(0,150).replace(/<[^>]*>/g,' ').trim()}; }
      });
    });
}

// $10 only if the original prints A3 sharply, matching the site's pricing rule
function suggestPrice(w, h){
  var short = Math.min(w, h), long = Math.max(w, h);
  var dpi = Math.min(short / A3[0], long / A3[1]);
  return dpi >= MIN_DPI ? '$10' : '$5';
}

function titleFromName(name){
  var base = name.replace(/\\.[^.]+$/, '');
  // Phone galleries hand over meaningless filenames — an asset UUID, IMG_0042,
  // PXL_20260808, a screenshot. Turning those into a "title" puts gibberish on
  // the site, so leave it blank and ask for a real one instead.
  var junk = /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(base)
    || /^(img|dsc|dscn|pxl|mvimg|photo|image|screenshot|scan|untitled)[\\s_-]*[\\d\\s_-]*$/i.test(base)
    || /^\\d{6,}$/.test(base);
  if (junk) return '';
  return base.replace(/[_-]+/g, ' ').replace(/\\s+/g, ' ').trim()
    .replace(/\\b\\w/g, function(c){ return c.toUpperCase(); }).slice(0, 120);
}

// Reads the picture's overall colour and brightness, so suggested names can
// suit a dark night scene or a purple lavender field rather than being generic.
function traitsOf(img){
  var c = document.createElement('canvas'); c.width = 48; c.height = 48;
  var x = c.getContext('2d'); x.drawImage(img, 0, 0, 48, 48);
  var d = x.getImageData(0, 0, 48, 48).data;
  var n = 48 * 48, sumL = 0, sumC = 0, bins = [0, 0, 0, 0, 0], i;
  for(i = 0; i < n; i++){
    var r = d[i*4]/255, g = d[i*4+1]/255, b = d[i*4+2]/255;
    var mx = Math.max(r,g,b), mn = Math.min(r,g,b), l = (mx+mn)/2;
    // chroma, not HSL saturation: HSL saturation shoots up near white, which
    // made pale ink washes read as strongly coloured
    var chroma = mx - mn;
    sumL += l; sumC += chroma;
    if(chroma > 0){
      var h;
      if(mx === r) h = (g-b)/chroma + (g < b ? 6 : 0);
      else if(mx === g) h = (b-r)/chroma + 2;
      else h = (r-g)/chroma + 4;
      h *= 60;
      var k = h < 45 ? 0 : h < 70 ? 1 : h < 160 ? 2 : h < 250 ? 3 : h < 315 ? 4 : 0;
      bins[k] += chroma;                  // near-grey pixels barely vote
    }
  }
  var dom = 0, j;
  for(j = 1; j < 5; j++){ if(bins[j] > bins[dom]) dom = j; }
  return {
    light: sumL / n,
    chroma: sumC / n,
    hue: ['warm','gold','green','blue','purple'][dom]
  };
}

function toneKey(t){
  if(t.light < 0.32) return 'dark';
  if(t.chroma < 0.12) return t.light > 0.55 ? 'bright' : 'dark';  // barely any colour
  if(t.light > 0.82) return 'bright';
  return t.hue;
}

function pick(arr, taken, count){
  var pool = arr.filter(function(n){ return taken.indexOf(n.toLowerCase()) < 0; });
  var out = [];
  while(out.length < count && pool.length){
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  }
  return out;
}

// Asks the server to look at the painting and title it. The pool-based names
// are already on screen, so a failure here just leaves those in place.
function askForTitles(s){
  s.titling = true;
  render();
  post({
    action: 'suggest',
    image: s.thumb,
    category: s.category,
    taken: existingHashes.map(function(e){ return e.title; })
      .concat(staged.map(function(x){ return x.title; }))
      .filter(Boolean)
  }).then(function(r){
    s.titling = false;
    if (r && r.ok && r.titles && r.titles.length){
      s.suggestions = r.titles;
      s.titledFromImage = true;
    }
    render();
  }).catch(function(){ s.titling = false; render(); });
}

// Three names from the category, with one swapped for a mood name only when the
// picture actually has a strong one. A washed-out photo of a car does not want
// to be called "High Summer".
var NO_MOOD = ['cars', 'interior'];

function suggestNames(s){
  var taken = existingHashes.map(function(e){ return String(e.title || '').toLowerCase(); })
    .concat(staged.map(function(x){ return String(x.title || '').toLowerCase(); }));
  var cat = NAME_POOLS[s.category] || NAME_POOLS.landscape;
  var t = s.traits || {light: 0.5, chroma: 0, hue: 'warm'};
  var key = toneKey(t);
  var strong = (key === 'dark') || (t.chroma >= 0.15);
  var useMood = strong && NO_MOOD.indexOf(s.category) < 0;
  if(!useMood) return pick(cat, taken, 3);
  return pick(cat, taken, 2).concat(pick(TONE_POOLS[key] || [], taken, 1));
}

// 8x8 average hash — cheap and good enough to catch the same photo uploaded twice
function hashOf(img){
  var c = document.createElement('canvas'); c.width = 8; c.height = 8;
  var x = c.getContext('2d'); x.drawImage(img, 0, 0, 8, 8);
  var d = x.getImageData(0, 0, 8, 8).data, g = [], i;
  for(i = 0; i < 64; i++){ g.push(0.299*d[i*4] + 0.587*d[i*4+1] + 0.114*d[i*4+2]); }
  var mean = g.reduce(function(a,b){ return a+b; }, 0) / 64;
  return g.map(function(v){ return v > mean ? '1' : '0'; }).join('');
}
function hamming(a, b){
  if(!a || !b || a.length !== b.length) return 99;
  var n = 0; for(var i = 0; i < a.length; i++){ if(a[i] !== b[i]) n++; }
  return n;
}

function readFile(file){
  return new Promise(function(resolve, reject){
    var img = new Image();
    var url = URL.createObjectURL(file);
    img.onload = function(){ resolve({img: img, url: url}); };
    img.onerror = function(){ URL.revokeObjectURL(url); reject(new Error('Could not read ' + file.name)); };
    img.src = url;
  });
}

// Burns the diagonal wordmark into the display copy. The website used to draw
// this on top in CSS, which meant anyone who saved or pinned the picture got a
// clean one. Now it is part of the pixels. The full-resolution original the
// buyer receives is never touched.
function stampWatermark(ctx, W, H){
  var text = 'JAMES HIGHLANDS ART';
  var font = Math.max(9, Math.round(W * 0.024));
  var track = font * (1.5 / 16);
  ctx.save();
  ctx.font = font + 'px Helvetica, Arial, sans-serif';
  ctx.textBaseline = 'top';
  var i, tw = 0;
  for (i = 0; i < text.length; i++) tw += ctx.measureText(text[i]).width + track;
  var stepX = Math.round(tw * 1.45);
  var stepY = Math.round(font * 3.4);
  var side = Math.round(Math.sqrt(W * W + H * H) * 1.25);
  // lay the rows out flat, then rotate the whole canvas, so rows stay evenly
  // spaced instead of colliding
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-25 * Math.PI / 180);
  ctx.translate(-side / 2, -side / 2);
  ctx.shadowColor = 'rgba(0,0,0,0.44)';
  ctx.shadowBlur = Math.max(1, font * (1.4 / 16)) * 2;
  ctx.fillStyle = 'rgba(255,255,255,0.53)';
  var row = 0;
  for (var y = 0; y < side; y += stepY) {
    for (var x = -stepX + (row % 2) * (stepX / 2); x < side; x += stepX) {
      var cx = x;
      for (i = 0; i < text.length; i++) {
        ctx.fillText(text[i], cx, y);
        cx += ctx.measureText(text[i]).width + track;
      }
    }
    row++;
  }
  ctx.restore();
}

function makeDisplay(img){
  var w = img.naturalWidth, h = img.naturalHeight;
  var scale = Math.min(1, MAX / Math.max(w, h));
  var c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  var ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, c.width, c.height);
  stampWatermark(ctx, c.width, c.height);
  // Safari and older browsers ignore image/webp here and quietly hand back a
  // PNG, which the server rejects and which is big enough to blow the request
  // size limit — so check what we actually got and fall back to JPEG.
  // Quality 0.72 rather than 0.85: the uploads were landing at ~360KB each,
  // several times the weight of the rest of the gallery, which made a page of
  // them crawl.
  var url = c.toDataURL('image/webp', 0.72);
  if (url.indexOf('data:image/webp') !== 0) url = c.toDataURL('image/jpeg', 0.72);
  // last resort for very large images: re-encode smaller rather than fail
  if (url.length > 3500000) url = c.toDataURL('image/jpeg', 0.6);
  return url;
}

function slugify(s){
  return String(s || 'painting').toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 60) || 'painting';
}

// Sends the photo exactly as it came off the camera: full size, no watermark,
// nothing re-encoded, straight to storage without passing through this site —
// which is the only way past the 4.5MB limit on anything sent to /api/upload.
// Resolves to the stored URL, or to null if it could not be sent, in which case
// the painting is still published and shows as needing its original.
function sendOriginal(s, onPct){
  if (!blobUpload || !s.file) return Promise.resolve(null);
  var ext = (/\.([A-Za-z0-9]{1,5})$/.exec(s.fileName || '') || [null, 'jpg'])[1].toLowerCase();
  var name = 'originals/' + slugify(s.title) + '-' + Date.now().toString(36) + '.' + ext;
  return blobUpload(name, s.file, {
    access: 'public',
    handleUploadUrl: location.pathname + '?pw=' + encodeURIComponent(PW),
    // splitting is only worth its extra requests on a file big enough to matter
    multipart: s.file.size > 8 * 1024 * 1024,
    onUploadProgress: function(p){ if (onPct) onPct(Math.round(p.percentage)); }
  }).then(function(b){ return b.url; }).catch(function(){ return null; });
}

// Instagram's feed refuses anything narrower than 4:5 or wider than 1.91:1, and
// two thirds of these paintings are shot 9:16. So the copy it gets is padded out
// to a shape it accepts — never cropped, which would cut into the painting — and
// flattened to JPEG, the only format it takes.
function instagramCopy(w){
  return new Promise(function(resolve, reject){
    var im = new Image();
    im.crossOrigin = 'anonymous';   // or the canvas is tainted and unreadable
    im.onerror = function(){ reject(new Error('Could not load that picture.')); };
    im.onload = function(){
      try {
        var iw = im.naturalWidth, ih = im.naturalHeight;
        var ratio = iw / ih;
        var target = Math.min(1.91, Math.max(0.8, ratio));
        // the smallest allowed canvas that still holds the whole painting
        var cw = iw, ch = ih;
        if (target > ratio) cw = Math.round(ih * target);
        else if (target < ratio) ch = Math.round(iw / target);
        var scale = Math.min(1, 1440 / cw);
        var c = document.createElement('canvas');
        c.width = Math.round(cw * scale);
        c.height = Math.round(ch * scale);
        var ctx = c.getContext('2d');
        // JPEG has no transparency, so the padding needs a colour of its own.
        // The site's own dark paper tone reads as deliberate rather than broken.
        ctx.fillStyle = '#211f1c';
        ctx.fillRect(0, 0, c.width, c.height);
        var dw = Math.round(iw * scale), dh = Math.round(ih * scale);
        ctx.drawImage(im, Math.round((c.width - dw) / 2), Math.round((c.height - dh) / 2), dw, dh);
        // paintings uploaded before the mark was burned in are still clean files,
        // and a picture going to Instagram is exactly one worth marking
        if (!w.watermarked) stampWatermark(ctx, c.width, c.height);
        c.toBlob(function(b){
          if (b) resolve(b); else reject(new Error('Could not prepare that picture.'));
        }, 'image/jpeg', 0.9);
      } catch (e) { reject(e); }
    };
    im.src = w.img_url;
  });
}

// Parks the Instagram copy in storage so Meta has a public URL to fetch. It is
// deleted again as soon as the post goes up.
function sendSocial(w, blob){
  if (!blobUpload) return Promise.reject(new Error('The uploader did not load. Reload the page.'));
  var name = 'social/' + slugify(w.title) + '-' + Date.now().toString(36) + '.jpg';
  return blobUpload(name, blob, {
    access: 'public',
    contentType: 'image/jpeg',
    handleUploadUrl: location.pathname + '?pw=' + encodeURIComponent(PW)
  }).then(function(b){ return b.url; });
}

// A starting caption, offered for editing rather than posted as-is.
function captionFor(w){
  var tag = function(s){ return '#' + slugify(s).replace(/-/g, ''); };
  var tags = ['#watercolour', '#painting', '#art'];
  if (w.category) tags.push(tag(w.category));
  if (w.region) tags.push(tag(w.region));
  if (w.style) tags.push(tag(w.style));
  return w.title + '\n\n' + tags.join(' ') + '\n\nPrints and downloads: jhart.vercel.app';
}

// small copy sent for titling — big enough to read the picture, small enough
// to keep the request quick
function makeThumb(img){
  var w = img.naturalWidth, h = img.naturalHeight;
  var scale = Math.min(1, 512 / Math.max(w, h));
  var c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// magnified bottom-right corner, where AI watermarks sit
function cornerCrop(img){
  var cw = 220, ch = 110;
  var c = document.createElement('canvas'); c.width = cw; c.height = ch;
  var sw = Math.min(img.naturalWidth, Math.round(img.naturalWidth * 0.33));
  var sh = Math.round(sw * (ch / cw));
  c.getContext('2d').drawImage(img, img.naturalWidth - sw, img.naturalHeight - sh, sw, sh, 0, 0, cw, ch);
  return c.toDataURL('image/png');
}

function render(){
  var box = document.getElementById('staged');
  box.innerHTML = '';
  staged.forEach(function(s, idx){
    var card = el('div', 'card');

    var thumbs = el('div', 'thumbs');
    var t = new Image(); t.className = 'thumb'; t.src = s.display; thumbs.appendChild(t);
    var cl = el('div', 'corner-lbl', 'bottom-right corner');
    var cimg = new Image(); cimg.className = 'corner'; cimg.src = s.corner;
    cimg.style.objectFit = 'contain';
    thumbs.appendChild(cl); thumbs.appendChild(cimg);
    card.appendChild(thumbs);

    var f = el('div');
    f.innerHTML =
      '<label>Title' + (s.title.trim() ? '' : ' — needed') + '</label>' +
      '<input type="text" data-k="title" placeholder="Tap a suggestion below, or type your own"' +
        (s.title.trim() ? '' : ' class="needed"') +
        ' value="' + s.title.replace(/"/g, '&quot;') + '">' +
      '<div class="sugg"></div>' +
      '<div class="row">' +
        '<div><label>Category</label><select data-k="category">${cats}</select></div>' +
        '<div><label>Country</label><select data-k="region">${regs}</select></div>' +
      '</div>' +
      '<div class="row">' +
        '<div><label>Style</label><select data-k="style">${stys}</select></div>' +
        '<div><label>Price</label><select data-k="price">' +
          PRICES.map(function(p){ return '<option>' + p + '</option>'; }).join('') +
        '</select></div>' +
      '</div>' +
      '<label>Search words (optional)</label><input type="text" data-k="tags" value="' + s.tags.replace(/"/g, '&quot;') + '">' +
      '<div class="meta">' + s.width + ' × ' + s.height + ' px · ' + s.fileName + '</div>';

    f.querySelector('[data-k=category]').value = s.category;
    f.querySelector('[data-k=region]').value = s.region;
    f.querySelector('[data-k=style]').value = s.style;
    f.querySelector('[data-k=price]').value = s.price;
    f.querySelectorAll('[data-k]').forEach(function(inp){
      inp.addEventListener('input', function(){ staged[idx][inp.dataset.k] = inp.value; });
      inp.addEventListener('change', function(){
        staged[idx][inp.dataset.k] = inp.value;
        // a different category means different names are appropriate
        if(inp.dataset.k === 'category'){
          staged[idx].suggestions = suggestNames(staged[idx]);
          render();
        }
      });
    });

    // tappable name suggestions
    var sg = f.querySelector('.sugg');
    (s.suggestions || []).forEach(function(name){
      var b = el('button', null, name);
      b.type = 'button';
      b.addEventListener('click', function(){
        staged[idx].title = name;
        render();
      });
      sg.appendChild(b);
    });
    var more = el('button', 'more', s.titledFromImage ? '↻ look again' : '↻ other names');
    more.type = 'button';
    more.addEventListener('click', function(){
      staged[idx].suggestions = suggestNames(staged[idx]);
      render();
      askForTitles(staged[idx]);
    });
    sg.appendChild(more);
    if (s.titling) sg.appendChild(el('span', 'titling', 'reading the painting…'));

    if(s.dupeOf){
      var d = el('div', 'dupe');
      d.textContent = 'Looks like a duplicate of "' + s.dupeOf + '" which is already on the site.';
      f.appendChild(d);
    }
    var rm = el('button', 'btn ghost', 'Remove');
    rm.style.marginTop = '10px';
    rm.addEventListener('click', function(){ staged.splice(idx, 1); render(); });
    f.appendChild(rm);

    card.appendChild(f);
    box.appendChild(card);
  });
  document.getElementById('bar').style.display = staged.length ? 'flex' : 'none';
  document.getElementById('publish').textContent =
    'Publish ' + staged.length + (staged.length === 1 ? ' painting' : ' paintings');
}

// drive the input from script rather than relying on label[for], which does
// not reliably reach a hidden input on every mobile browser
document.querySelector('.pick').addEventListener('click', function(e){
  e.preventDefault();
  try { document.getElementById('files').click(); }
  catch(err){ say('This browser would not open the photo chooser: ' + err.message); }
});

document.getElementById('files').addEventListener('change', function(ev){
  var files = [].slice.call(ev.target.files || []);
  ev.target.value = '';
  if(!files.length){ say('No photos were selected.'); return; }
  say('Reading ' + files.length + ' photo' + (files.length === 1 ? '' : 's') + '…');
  files.reduce(function(chain, file){
    return chain.then(function(){
      return readFile(file).then(function(r){
        var hash = hashOf(r.img);
        var dupe = null;
        existingHashes.concat(staged.map(function(s){ return {phash: s.phash, title: s.title}; }))
          .forEach(function(e){ if(!dupe && hamming(e.phash, hash) <= 5) dupe = e.title; });
        staged.push({
          file: file,              // kept whole, so the original can be sent as-is
          fileName: file.name,
          title: titleFromName(file.name),
          category: 'landscape',
          region: '',
          style: '',
          price: suggestPrice(r.img.naturalWidth, r.img.naturalHeight),
          tags: '',
          width: r.img.naturalWidth,
          height: r.img.naturalHeight,
          display: makeDisplay(r.img),
          corner: cornerCrop(r.img),
          phash: hash,
          traits: traitsOf(r.img),
          thumb: makeThumb(r.img),
          dupeOf: dupe
        });
        var last = staged[staged.length - 1];
        last.suggestions = suggestNames(last);   // shown immediately
        askForTitles(last);                      // replaced when the real ones arrive
        URL.revokeObjectURL(r.url);
        render();
      });
    });
  }, Promise.resolve())
    .then(function(){ say(''); })
    .catch(function(e){
      say('Could not read that photo: ' + (e && e.message ? e.message : e) +
          ' — if it came straight off an iPhone try sharing it as JPEG, or pick it from Photos rather than Files.');
    });
});

document.getElementById('publish').addEventListener('click', function(){
  var btn = this, status = document.getElementById('status');
  var unnamed = staged.filter(function(s){ return !String(s.title).trim(); }).length;
  if (unnamed){
    status.textContent = unnamed === 1
      ? 'One painting still needs a title.'
      : unnamed + ' paintings still need a title.';
    return;
  }
  btn.disabled = true;
  var done = 0, failed = [], noOriginal = [];
  staged.slice().reduce(function(chain, s){
    return chain.then(function(){
      var n = done + noOriginal.length + failed.length + 1;
      // the big file first: if it cannot be sent there is no point pretending
      // afterwards that the painting is ready to sell
      status.textContent = 'Sending the full-size ' + s.title + ' — 0%';
      return sendOriginal(s, function(pct){
        status.textContent = 'Sending the full-size ' + s.title + ' — ' + pct + '%';
      }).then(function(originalUrl){
        status.textContent = 'Publishing ' + n + ' of ' + staged.length + '…';
        return post({
          action: 'save', title: s.title, category: s.category, region: s.region, style: s.style,
          price: s.price, tags: s.tags, width: s.width, height: s.height,
          image: s.display, phash: s.phash, originalUrl: originalUrl
        });
      }).then(function(r){
        if(!r.ok){ failed.push(s.title + ': ' + r.error); }
        else if(r.original){ done++; }
        else { noOriginal.push(s.title); }
      }).catch(function(e){ failed.push(s.title + ': ' + e.message); });
    });
  }, Promise.resolve()).then(function(){
    staged = [];
    render();
    btn.disabled = false;
    var parts = [];
    if (done) parts.push('Published ' + done + ' with the full-size file saved.');
    if (noOriginal.length) parts.push('Published ' + noOriginal.length +
      ' without the full-size file: ' + noOriginal.join(', ') +
      '. They show "original needed" below — tap Add original to send it.');
    if (failed.length) parts.push('Failed: ' + failed.join(' | '));
    status.textContent = parts.join(' ') || 'Nothing was published.';
    loadLive();
  });
});

// Older uploads are clean files with the mark only drawn over them by the
// website, so anyone who saves one gets unmarked art. This re-stamps them for
// real: the page pulls each picture back, burns the mark in with the same code
// that marks new uploads, and sends the result to replace the stored file.
var REMARK = { list: [], running: false, done: 0, failed: 0 };

function remarkOne(w){
  return new Promise(function(resolve){
    var im = new Image();
    im.crossOrigin = 'anonymous';   // needed or the canvas is tainted and unreadable
    im.onload = function(){
      try {
        var c = document.createElement('canvas');
        c.width = im.naturalWidth; c.height = im.naturalHeight;
        var ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0);
        stampWatermark(ctx, c.width, c.height);
        var url = c.toDataURL('image/webp', 0.72);
        if (url.indexOf('data:image/webp') !== 0) url = c.toDataURL('image/jpeg', 0.72);
        post({ action: 'remark', id: w.id, image: url })
          .then(function(r){ resolve(!!(r && r.ok)); })
          .catch(function(){ resolve(false); });
      } catch (e) { resolve(false); }
    };
    im.onerror = function(){ resolve(false); };
    im.src = w.img_url;
  });
}

function renderRemark(){
  var box = document.getElementById('remarkPanel');
  if (REMARK.running){
    box.style.display = 'block';
    box.innerHTML = '';
    var p = el('div', 'remark');
    p.appendChild(el('b', null, 'Adding the watermark to older paintings…'));
    p.appendChild(el('div', 'prog',
      'Done ' + REMARK.done + ' of ' + REMARK.list.length +
      (REMARK.failed ? '  ·  ' + REMARK.failed + ' could not be done' : '') +
      '. Leave this page open until it finishes.'));
    box.appendChild(p);
    return;
  }
  if (!REMARK.list.length){ box.style.display = 'none'; box.innerHTML = ''; return; }
  box.style.display = 'block';
  box.innerHTML = '';
  var p = el('div', 'remark');
  p.appendChild(el('b', null, REMARK.list.length + ' older paintings have no watermark in the file'));
  p.appendChild(document.createTextNode(
    'They look marked on the site, but the mark is only drawn on top — save or pin one and it comes out clean. ' +
    'This burns it into the picture itself. It replaces the stored file, so it cannot be undone. ' +
    'The full-size originals are not touched.'));
  var b = el('button', 'btn', 'Add the watermark to all ' + REMARK.list.length);
  b.type = 'button';
  b.addEventListener('click', function(){ runRemark(); });
  p.appendChild(b);
  box.appendChild(p);
}

function runRemark(){
  if (REMARK.running || !REMARK.list.length) return;
  REMARK.running = true; REMARK.done = 0; REMARK.failed = 0;
  renderRemark();
  REMARK.list.slice().reduce(function(chain, w){
    return chain.then(function(){
      return remarkOne(w).then(function(ok){
        if (ok) REMARK.done++; else REMARK.failed++;
        renderRemark();
      });
    });
  }, Promise.resolve()).then(function(){
    REMARK.running = false;
    loadLive();          // refresh: anything done drops out of the list
  });
}

function loadLive(){
  post({action: 'list'}).then(function(r){
    var box = document.getElementById('live');
    box.innerHTML = '';
    if(!r.ok){ box.appendChild(el('div', 'sub', r.error || 'Could not load.')); return; }
    existingHashes = r.works.map(function(w){ return {phash: w.phash, title: w.title}; });
    REMARK.list = r.works.filter(function(w){ return !w.watermarked; });
    renderRemark();
    if(!r.works.length){ box.appendChild(el('div', 'sub', 'Nothing uploaded through this page yet.')); return; }
    r.works.forEach(function(w){
      var row = el('div', 'live');
      var im = new Image(); im.src = w.img_url; row.appendChild(im);
      var g = el('div', 'g');
      // editable in place, so a painting that arrived with a phone's filename
      // as its title can be named without deleting and uploading it again
      var t = document.createElement('input');
      t.type = 'text'; t.className = 't'; t.value = w.title;
      t.addEventListener('change', function(){
        var v = t.value.trim();
        if(!v || v === w.title){ t.value = w.title; return; }
        t.disabled = true;
        post({action:'rename', id: w.id, title: v}).then(function(res){
          t.disabled = false;
          if(res.ok){ w.title = v; } else { t.value = w.title; alert(res.error); }
        });
      });
      g.appendChild(t);
      var d = el('div', 'd', w.category + (w.region ? ' · ' + w.region : '') +
        (w.style ? ' · ' + w.style.replace(/-/g, ' ') : '') +
        ' · ' + w.price + ' · ' + w.width + '×' + w.height);
      if(w.original_pending){ d.appendChild(el('span', 'pending', 'original needed')); }
      if(w.instagram_id){
        var posted = el('span', 'pending', 'on instagram');
        posted.style.background = '#4a7c59';
        d.appendChild(posted);
      }
      g.appendChild(d); row.appendChild(g);

      // Every painting uploaded before this page could send big files went up as
      // a 1400px web copy only, so it cannot be fulfilled if it sells. This adds
      // the real file to one of them without deleting and re-uploading the work.
      if(w.original_pending){
        var of = document.createElement('input');
        of.type = 'file'; of.accept = 'image/*'; of.style.display = 'none';
        var ob = el('button', 'btn ghost', 'Add original');
        ob.addEventListener('click', function(){ of.click(); });
        of.addEventListener('change', function(){
          var file = of.files && of.files[0];
          if(!file) return;
          if(!blobUpload){ alert('The uploader did not load. Reload the page and try again.'); return; }
          ob.disabled = true; ob.textContent = '0%';
          sendOriginal({file: file, fileName: file.name, title: w.title}, function(pct){
            ob.textContent = pct + '%';
          }).then(function(url){
            if(!url){
              ob.disabled = false; ob.textContent = 'Add original';
              alert('That did not reach storage. Try again on a better connection.');
              return;
            }
            return post({action:'attach-original', id: w.id, originalUrl: url}).then(function(res){
              if(res.ok){ loadLive(); }
              else { ob.disabled = false; ob.textContent = 'Add original'; alert(res.error); }
            });
          });
        });
        row.appendChild(of); row.appendChild(ob);
      }

      // One tap: pad the picture to a shape Instagram accepts, park it in
      // storage for Meta to fetch, post it, then delete our copy again.
      if(IG_READY && !w.instagram_id){
        var ig = el('button', 'btn ghost', 'Post to Instagram');
        ig.addEventListener('click', function(){
          var cap = prompt('Caption for Instagram:', captionFor(w));
          if(cap === null) return;
          ig.disabled = true; ig.textContent = 'Preparing…';
          instagramCopy(w).then(function(blob){
            ig.textContent = 'Sending…';
            return sendSocial(w, blob);
          }).then(function(url){
            ig.textContent = 'Posting…';
            return post({action:'instagram-post', id: w.id, imageUrl: url, caption: cap});
          }).then(function(res){
            if(res && res.ok){ loadLive(); }
            else {
              ig.disabled = false; ig.textContent = 'Post to Instagram';
              alert((res && res.error) || 'Could not post that.');
            }
          }).catch(function(e){
            ig.disabled = false; ig.textContent = 'Post to Instagram';
            alert(e.message || 'Could not post that.');
          });
        });
        row.appendChild(ig);
      }

      var b = el('button', 'btn ghost', 'Delete');
      b.addEventListener('click', function(){
        if(!confirm('Remove "' + w.title + '" from the site?')) return;
        b.disabled = true; b.textContent = '…';
        post({action:'delete', id: w.id}).then(function(res){
          if(res.ok){ loadLive(); } else { b.disabled = false; b.textContent = 'Delete'; alert(res.error); }
        });
      });
      row.appendChild(b);
      box.appendChild(row);
    });
  });
}
loadLive();
</script>
</body></html>`;
}
