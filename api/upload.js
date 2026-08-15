import postgres from 'postgres';
import crypto from 'node:crypto';
import { put, del } from '@vercel/blob';
import { ensureWorksTable } from './works.js';

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
  'coast', 'rivers', 'wildlife', 'cars', 'landscape', 'interior'];
const REGIONS = ['', 'oman', 'china', 'scotland', 'france', 'italy', 'uk', 'usa', 'uae'];

function deny(res) {
  res.status(401).setHeader('content-type', 'text/html');
  res.send('<body style="font-family:system-ui;background:#211f1c;color:#FFF2DB;display:flex;height:100vh;align-items:center;justify-content:center;margin:0"><div>401 — Unauthorized</div></body>');
}

export default async function handler(req, res) {
  const pw = req.method === 'POST' ? (req.body && req.body.pw) : req.query.pw;
  if (!pwOk(pw)) return deny(res);

  if (req.method === 'POST') return handlePost(req, res);
  // never let a browser hold on to an old copy of this page
  res.setHeader('cache-control', 'no-store, must-revalidate');
  return res.setHeader('content-type', 'text/html').status(200).send(page(String(req.query.pw)));
}

async function handlePost(req, res) {
  const body = req.body || {};
  try {
    const sql = getSql();
    await ensureWorksTable(sql);

    if (body.action === 'list') {
      const rows = await sql`SELECT id, title, category, region, price, width, height, img_url,
        phash, original_pending, created_at FROM works WHERE hidden = false ORDER BY created_at DESC`;
      return res.status(200).json({ ok: true, works: rows });
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
      const [row] = await sql`SELECT img_url FROM works WHERE id = ${id}`;
      if (row && row.img_url) { try { await del(row.img_url); } catch (e) { /* blob already gone */ } }
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
      const price = /^\$\d+$/.test(String(body.price)) ? String(body.price) : '$5';
      const tags = String(body.tags || '').trim().slice(0, 400) || null;
      const phash = /^[01]{64}$/.test(String(body.phash || '')) ? String(body.phash) : null;

      const name = 'uploads/' + slug(title) + '-' + Date.now().toString(36) + (fmt === 'webp' ? '.webp' : '.jpg');
      const blob = await put(name, buf, { access: 'public', contentType: 'image/' + fmt });

      const [row] = await sql`INSERT INTO works
        (title, category, region, tags, price, width, height, img_url, phash)
        VALUES (${title}, ${category}, ${region}, ${tags}, ${price}, ${width}, ${height}, ${blob.url}, ${phash})
        RETURNING id`;
      return res.status(200).json({ ok: true, id: row.id, url: blob.url });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}

// bumped by hand when this page changes, so it's possible to tell from the
// page itself whether a browser is showing an old copy
const PAGE_VERSION = 'v4';

function page(pw) {
  const needsBlob = !process.env.BLOB_READ_WRITE_TOKEN;
  const setupNote = needsBlob ? `<div class="warn setup">
    <b>Image storage isn't connected yet.</b> In the Vercel dashboard open this project →
    Storage → Create a Blob store and link it. That sets <code>BLOB_READ_WRITE_TOKEN</code>
    automatically. Uploads will fail until then.</div>` : '';

  const cats = CATEGORIES.map(c => '<option value="' + c + '">' + c + '</option>').join('');
  const regs = REGIONS.map(r => '<option value="' + r + '">' + (r || '— none —') + '</option>').join('');

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
  .live .d{font-size:11px;color:var(--dim);margin-top:2px;}
  .pending{display:inline-block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;background:var(--accent);
    color:#fff;padding:2px 6px;margin-left:6px;}
  @media(max-width:560px){ .card{grid-template-columns:1fr;} .thumbs{flex-direction:row;} .thumb,.corner{width:50%;height:96px;} }
</style></head><body>
<h1>Add Paintings</h1>
<div class="sub">Pick photos, check each one, then publish. They appear on the site straight away.
  &nbsp;<span style="opacity:.5">${PAGE_VERSION}</span></div>
${setupNote}
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

<h2>Already on the site</h2>
<div class="sub">Uploaded through this page. Deleting removes it from the site immediately.</div>
<div id="live"></div>

<script>
var PW = ${JSON.stringify(pw)};
var MAX = 1400;              // display copies are capped at 1400px, same as the rest of the site
var MIN_DPI = 170;           // matches the gallery: no soft or stretched prints
var A3 = [11.69, 16.54];
var staged = [];
var existingHashes = [];

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

function makeDisplay(img){
  var w = img.naturalWidth, h = img.naturalHeight;
  var scale = Math.min(1, MAX / Math.max(w, h));
  var c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  // Safari and older browsers ignore image/webp here and quietly hand back a
  // PNG, which the server rejects and which is big enough to blow the request
  // size limit — so check what we actually got and fall back to JPEG.
  var url = c.toDataURL('image/webp', 0.85);
  if (url.indexOf('data:image/webp') !== 0) url = c.toDataURL('image/jpeg', 0.85);
  // last resort for very large images: re-encode smaller rather than fail
  if (url.length > 3500000) url = c.toDataURL('image/jpeg', 0.7);
  return url;
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
      '<input type="text" data-k="title" placeholder="Type a title for this painting"' +
        (s.title.trim() ? '' : ' class="needed"') +
        ' value="' + s.title.replace(/"/g, '&quot;') + '">' +
      '<div class="row">' +
        '<div><label>Category</label><select data-k="category">${cats}</select></div>' +
        '<div><label>Country</label><select data-k="region">${regs}</select></div>' +
        '<div><label>Price</label><select data-k="price"><option>$5</option><option>$10</option></select></div>' +
      '</div>' +
      '<label>Search words (optional)</label><input type="text" data-k="tags" value="' + s.tags.replace(/"/g, '&quot;') + '">' +
      '<div class="meta">' + s.width + ' × ' + s.height + ' px · ' + s.fileName + '</div>';

    f.querySelector('[data-k=category]').value = s.category;
    f.querySelector('[data-k=region]').value = s.region;
    f.querySelector('[data-k=price]').value = s.price;
    f.querySelectorAll('[data-k]').forEach(function(inp){
      inp.addEventListener('input', function(){ staged[idx][inp.dataset.k] = inp.value; });
      inp.addEventListener('change', function(){ staged[idx][inp.dataset.k] = inp.value; });
    });

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
          fileName: file.name,
          title: titleFromName(file.name),
          category: 'landscape',
          region: '',
          price: suggestPrice(r.img.naturalWidth, r.img.naturalHeight),
          tags: '',
          width: r.img.naturalWidth,
          height: r.img.naturalHeight,
          display: makeDisplay(r.img),
          corner: cornerCrop(r.img),
          phash: hash,
          dupeOf: dupe
        });
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
  var done = 0, failed = [];
  staged.slice().reduce(function(chain, s){
    return chain.then(function(){
      status.textContent = 'Uploading ' + (done + 1) + ' of ' + staged.length + '…';
      return post({
        action: 'save', title: s.title, category: s.category, region: s.region,
        price: s.price, tags: s.tags, width: s.width, height: s.height,
        image: s.display, phash: s.phash
      }).then(function(r){
        if(r.ok){ done++; } else { failed.push(s.title + ': ' + r.error); }
      }).catch(function(e){ failed.push(s.title + ': ' + e.message); });
    });
  }, Promise.resolve()).then(function(){
    staged = [];
    render();
    btn.disabled = false;
    status.textContent = failed.length
      ? ('Published ' + done + '. Failed: ' + failed.join(' | '))
      : ('Published ' + done + '. They are live on the site now.');
    loadLive();
  });
});

function loadLive(){
  post({action: 'list'}).then(function(r){
    var box = document.getElementById('live');
    box.innerHTML = '';
    if(!r.ok){ box.appendChild(el('div', 'sub', r.error || 'Could not load.')); return; }
    existingHashes = r.works.map(function(w){ return {phash: w.phash, title: w.title}; });
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
      var d = el('div', 'd', w.category + (w.region ? ' · ' + w.region : '') + ' · ' + w.price + ' · ' + w.width + '×' + w.height);
      if(w.original_pending){ d.appendChild(el('span', 'pending', 'original needed')); }
      g.appendChild(d); row.appendChild(g);
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
