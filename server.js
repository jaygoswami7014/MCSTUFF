// Parent process only supervises (re-spawns the server on restart).
const supervisor = require('./src/supervisor');
if (supervisor.shouldSupervise()) {
  supervisor.start(__filename);
  return;
}

const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { db, UPLOAD_DIR } = require('./src/db');
const SQLiteStore = require('./src/session-store');
const updater = require('./src/updater');

const app = express();
const PORT = process.env.PORT || 3000;
const BOOT_ID = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
const PUB = path.join(__dirname, 'public');

const SECTIONS = [
  { slug: 'resource-packs', name: 'Resource Packs', blurb: 'Textures, GUIs and sounds', live: true },
  { slug: 'farm-schematics', name: 'Farm Schematics', blurb: 'Ready-to-paste builds', live: false },
  { slug: 'mods', name: 'Mods', blurb: 'Fabric and Forge', live: false },
  { slug: 'shaders', name: 'Shaders', blurb: 'Light, water and sky', live: false }
];

app.set('trust proxy', 1);

// Same restart logic as before: exit code 75 -> supervisor respawns the server in ~1s (no 502 gap)
function restartSelf(reason, delayMs = 1200) {
  const code = process.env.MCSTUFF_CHILD ? supervisor.RESTART_CODE : 1;
  console.log('[restart] ' + reason + ' - restarting in ' + delayMs + 'ms (exit ' + code + ')');
  setTimeout(() => process.exit(code), delayMs);
}

app.use(express.json({ limit: '1mb' }));
app.use(session({
  store: new SQLiteStore(db),
  secret: process.env.SESSION_SECRET || 'mcstuff-change-this-secret',
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { maxAge: 7 * 24 * 3600 * 1000, httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' }
}));

const json = (res, data, code = 200) => res.status(code).json(data);
const me = (req) => req.session.uid ? db.prepare('SELECT id, username, email, is_admin FROM users WHERE id = ?').get(req.session.uid) : null;
const adminOnly = (req, res, next) => {
  const u = me(req);
  if (!u) return json(res, { error: 'Login required' }, 401);
  if (!u.is_admin) return json(res, { error: 'Admin only' }, 403);
  req.user = u; next();
};

// ---- ping (browser polls this after a restart) ----
app.get('/api/ping', (req, res) => { res.set('Cache-Control', 'no-store'); json(res, { ok: true, boot: BOOT_ID }); });

// ---- auth ----
const tries = new Map();
function throttled(ip) {
  const now = Date.now();
  const list = (tries.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  tries.set(ip, list);
  return list.length >= 12;
}
const noteTry = (ip) => tries.set(ip, [...(tries.get(ip) || []), Date.now()]);

app.get('/api/me', (req, res) => {
  const u = me(req);
  const n = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  json(res, { user: u ? { username: u.username, is_admin: !!u.is_admin } : null, firstUser: n === 0 });
});

app.post('/api/register', (req, res) => {
  if (throttled(req.ip)) return json(res, { error: 'Too many attempts. Try again later.' }, 429);
  noteTry(req.ip);
  const { username = '', email = '', password = '' } = req.body || {};
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return json(res, { error: 'Username: 3-20 letters, numbers or _' }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: 'Enter a valid email' }, 400);
  if (password.length < 6) return json(res, { error: 'Password must be at least 6 characters' }, 400);
  const hash = bcrypt.hashSync(password, 10);
  try {
    // one transaction: whoever registers first becomes admin automatically
    const id = db.transaction(() => {
      const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
      return db.prepare('INSERT INTO users (username, email, password, is_admin) VALUES (?,?,?,?)')
        .run(username, email, hash, first ? 1 : 0).lastInsertRowid;
    })();
    req.session.uid = Number(id);
    json(res, { ok: true });
  } catch (e) {
    json(res, { error: 'Username or email already used' }, 409);
  }
});

app.post('/api/login', (req, res) => {
  if (throttled(req.ip)) return json(res, { error: 'Too many attempts. Try again later.' }, 429);
  const { login = '', password = '' } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(login, login);
  if (!u || !bcrypt.compareSync(password, u.password)) { noteTry(req.ip); return json(res, { error: 'Wrong username or password' }, 401); }
  req.session.uid = u.id;
  json(res, { ok: true });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => json(res, { ok: true })));

// ---- public content ----
app.get('/api/sections', (req, res) => {
  const counts = Object.fromEntries(db.prepare('SELECT section, COUNT(*) c FROM items GROUP BY section').all().map(r => [r.section, r.c]));
  json(res, SECTIONS.map(s => ({ ...s, count: counts[s.slug] || 0 })));
});

const pub = (r) => ({
  id: r.id, title: r.title, description: r.description, version: r.version, mc_version: r.mc_version,
  image: r.image ? '/uploads/img/' + r.image : null, downloads: r.downloads, created_at: r.created_at,
  size: r.file ? (() => { try { return fs.statSync(path.join(UPLOAD_DIR, 'files', r.file)).size; } catch { return 0; } })() : 0
});

app.get('/api/items', (req, res) => {
  const sec = SECTIONS.find(s => s.slug === req.query.section && s.live);
  if (!sec) return json(res, []);
  json(res, db.prepare('SELECT * FROM items WHERE section = ? ORDER BY id DESC').all(sec.slug).map(pub));
});

app.get('/download/:id', (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!it) return res.status(404).send('Not found');
  db.prepare('UPDATE items SET downloads = downloads + 1 WHERE id = ?').run(it.id);
  if (it.file) {
    const fp = path.join(UPLOAD_DIR, 'files', it.file);
    if (fs.existsSync(fp)) return res.download(fp, it.file_name || it.file);
  }
  if (it.ext_url) return res.redirect(it.ext_url);
  res.status(404).send('File missing');
});

app.use('/uploads/img', express.static(path.join(UPLOAD_DIR, 'img'), { maxAge: '7d' }));

// ---- admin: items ----
const MAX_FILE = 2 * 1024 * 1024 * 1024;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(UPLOAD_DIR, file.fieldname === 'image' ? 'img' : 'files')),
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(file.originalname).toLowerCase().slice(0, 12))
  }),
  limits: { fileSize: MAX_FILE },
  fileFilter: (req, file, cb) => (file.fieldname === 'image' && !/^image\//.test(file.mimetype)) ? cb(new Error('Cover must be an image')) : cb(null, true)
});
const rmFile = (sub, name) => { if (name) try { fs.unlinkSync(path.join(UPLOAD_DIR, sub, name)); } catch {} };

app.post('/api/admin/items', adminOnly, upload.fields([{ name: 'image', maxCount: 1 }, { name: 'file', maxCount: 1 }]), (req, res) => {
  const img = req.files?.image?.[0], file = req.files?.file?.[0];
  const clean = () => { rmFile('img', img?.filename); rmFile('files', file?.filename); };
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 100);
  const link = String(b.link || '').trim();
  if (!title) { clean(); return json(res, { error: 'Title is required' }, 400); }
  if (link && !/^https?:\/\//i.test(link)) { clean(); return json(res, { error: 'Link must start with http:// or https://' }, 400); }
  if (!file && !link) { clean(); return json(res, { error: 'Upload a file or paste a download link' }, 400); }
  const r = db.prepare('INSERT INTO items (section,title,description,version,mc_version,image,file,file_name,ext_url) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('resource-packs', title, String(b.description || '').slice(0, 1500), String(b.version || '').slice(0, 30),
      String(b.mc_version || '').slice(0, 30), img?.filename || null, file?.filename || null, file?.originalname || null, link || null);
  json(res, { ok: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/items/:id', adminOnly, (req, res) => {
  const it = db.prepare('SELECT * FROM items WHERE id = ?').get(Number(req.params.id));
  if (!it) return json(res, { error: 'Not found' }, 404);
  db.prepare('DELETE FROM items WHERE id = ?').run(it.id);
  rmFile('img', it.image); rmFile('files', it.file);
  json(res, { ok: true });
});

app.get('/api/admin/users', adminOnly, (req, res) =>
  json(res, db.prepare('SELECT id, username, email, is_admin, created_at FROM users ORDER BY id').all()));

// ---- admin: ZIP update (same logic: check -> apply -> backup -> auto restart -> browser auto reload) ----
const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: updater.MAX_ZIP } });

app.get('/api/admin/updater/info', adminOnly, (req, res) => json(res, updater.info()));

app.post('/api/admin/updater/check', adminOnly, memoryUpload.single('zip'), (req, res) => {
  try {
    if (!req.file) return json(res, { error: 'No ZIP uploaded' }, 400);
    json(res, updater.check(req.file.buffer));
  } catch (e) { json(res, { error: e.message }, 400); }
});

app.post('/api/admin/updater/apply', adminOnly, (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) return json(res, { error: 'Token required' }, 400);
    const result = updater.apply(token, req.user.username);
    result.message = 'Update applied! Server is restarting automatically...';
    result.restarting = true;
    json(res, result);
    restartSelf('ZIP update applied');
  } catch (e) { json(res, { error: e.message }, 400); }
});

app.post('/api/admin/updater/rollback', adminOnly, (req, res) => {
  try {
    const { backupId } = req.body || {};
    let id = backupId;
    if (!id) {
      const list = updater.listBackups();
      if (!list.length) return json(res, { error: 'No backups available' }, 400);
      id = list[0].id;
    }
    const result = updater.rollback(id);
    result.message = 'Rollback done! Server is restarting automatically...';
    result.restarting = true;
    json(res, result);
    restartSelf('rollback');
  } catch (e) { json(res, { error: e.message }, 400); }
});

app.post('/api/admin/updater/clear-history', adminOnly, (req, res) => { try { json(res, updater.clearHistory()); } catch (e) { json(res, { error: e.message }, 400); } });
app.post('/api/admin/updater/clear-backups', adminOnly, (req, res) => { try { json(res, updater.clearBackups()); } catch (e) { json(res, { error: e.message }, 400); } });

app.get('/api/admin/updater/export', adminOnly, (req, res) => {
  try {
    const buf = updater.exportSiteZip();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="mcstuff-site.zip"');
    res.send(buf);
  } catch (e) { json(res, { error: e.message }, 500); }
});

// ---- pages ----
const page = (file) => (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, file)); };
app.get('/', page('index.html'));
app.get('/resource-packs', page('resource-packs.html'));
app.get('/login', page('login.html'));
app.get('/admin', (req, res) => {
  const u = me(req);
  if (!u || !u.is_admin) return res.redirect('/login?next=/admin');
  page('admin.html')(req, res);
});
app.use(express.static(PUB, {
  index: false,
  setHeaders: (res, fp) => { if (/\.(html?|js|css)$/i.test(fp)) res.setHeader('Cache-Control', 'no-cache'); }
}));

app.use((err, req, res, next) => {
  console.error('error:', err.message);
  json(res, { error: err.code === 'LIMIT_FILE_SIZE' ? 'File too large' : err.message }, 400);
});

app.listen(PORT, () => console.log('MCSTUFF running on port ' + PORT));
