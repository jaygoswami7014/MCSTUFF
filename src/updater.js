/**
 * MCSTUFF — ZIP updater + rollback + export
 * Protects: data/, public/uploads/, node_modules/
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const MAX_ZIP = 80 * 1024 * 1024;
const MAX_UNPACKED = 200 * 1024 * 1024;
const MAX_ENTRIES = 5000;

const pending = new Map();

// CRC32 (needed for valid ZIPs - zlib.crc32 doesn't exist on Node 18/20)
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function isProtected(rel) {
  const r = rel.replace(/\\/g, '/');
  if (r === 'data' || r.startsWith('data/')) return true;
  if (r === 'public/uploads' || r.startsWith('public/uploads/')) return true;
  if (r === 'node_modules' || r.startsWith('node_modules/')) return true;
  if (r === '.git' || r.startsWith('.git/')) return true;
  if (r === 'package-lock.json') return true;
  return false;
}

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid ZIP file (EOCD not found)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || off === 0xffffffff) throw new Error('ZIP64 not supported');
  if (count > MAX_ENTRIES) throw new Error('Too many files in ZIP');
  const out = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('Corrupt ZIP (central directory)');
    const flags = buf.readUInt16LE(off + 8);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const usize = buf.readUInt32LE(off + 24);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Password-protected ZIP not supported');
    total += usize;
    if (total > MAX_UNPACKED) throw new Error('ZIP too large when unpacked');
    out.push({ name, method, csize, usize, lho });
  }
  return out;
}

function extract(buf, e) {
  if (buf.readUInt32LE(e.lho) !== 0x04034b50) throw new Error('Corrupt ZIP: ' + e.name);
  const nlen = buf.readUInt16LE(e.lho + 26);
  const elen = buf.readUInt16LE(e.lho + 28);
  let dataOff = e.lho + 30 + nlen + elen;
  const raw = buf.subarray(dataOff, dataOff + e.csize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('Unsupported compression: ' + e.method + ' in ' + e.name);
}

function detectPrefix(entries) {
  const names = entries.map(e => e.name.replace(/\\/g, '/'));
  const hasServer = names.some(n => n === 'server.js' || n.endsWith('/server.js'));
  if (hasServer) {
    for (const n of names) {
      if (n.endsWith('/server.js')) return n.slice(0, n.length - 'server.js'.length);
      if (n === 'server.js') return '';
    }
  }
  const first = names[0] || '';
  const slash = first.indexOf('/');
  if (slash > 0) {
    const prefix = first.slice(0, slash + 1);
    if (names.every(n => n.startsWith(prefix) || !n.includes('/'))) return prefix;
  }
  return '';
}

function buildPlan(buf) {
  const entries = readZip(buf).map(e => {
    let clean = e.name.replace(/\\/g, '/');
    if (clean.startsWith('/')) clean = clean.slice(1);
    return { ...e, clean };
  });
  const prefix = detectPrefix(entries);
  const servers = entries.filter(e => {
    let rel = e.clean;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    return rel === 'server.js';
  });

  const files = [];
  let added = 0, changed = 0, same = 0;
  const changedList = [];
  const skipped = [];

  for (const e of entries) {
    let rel = e.clean;
    if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
    if (!rel || isProtected(rel)) {
      if (rel) skipped.push(rel);
      continue;
    }
    const data = extract(buf, e);
    const dest = path.join(ROOT, rel);
    let status = 'added';
    if (fs.existsSync(dest)) {
      const cur = fs.readFileSync(dest);
      if (cur.equals(data)) { status = 'same'; same++; }
      else { status = 'changed'; changed++; changedList.push(rel); }
    } else {
      added++;
      changedList.push('+ ' + rel);
    }
    files.push({ rel, data, status });
  }

  return { files, added, changed, same, skipped, changedList, fullUpdate: !!servers.length };
}

function check(buf) {
  if (!buf || buf.length < 22) throw new Error('Invalid ZIP');
  if (buf.length > MAX_ZIP) throw new Error('ZIP too large (max 80MB)');
  const plan = buildPlan(buf);
  const warnings = [];
  if (plan.added + plan.changed === 0) warnings.push('No new changes (all files identical).');
  if (plan.skipped.length) warnings.push(plan.skipped.length + ' protected file(s) skipped (data/uploads).');

  const token = crypto.randomBytes(16).toString('hex');
  pending.set(token, { buf, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60 * 1000) pending.delete(k);

  return {
    token,
    updateType: plan.fullUpdate ? 'full' : 'partial',
    added: plan.added,
    changed: plan.changed,
    same: plan.same,
    protectedSkipped: plan.skipped.length,
    changedFiles: plan.changedList.slice(0, 60),
    moreFiles: Math.max(0, plan.changedList.length - 60),
    warnings
  };
}

function makeBackup() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const id = 'bak_' + Date.now();
  const dir = path.join(BACKUP_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const toBackup = ['server.js', 'package.json', 'src', 'public'];
  for (const item of toBackup) {
    const src = path.join(ROOT, item);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, item);
    const st = fs.statSync(src);
    if (st.isDirectory()) copyDir(src, dest);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  hist.unshift({ id, at: new Date().toISOString(), label: 'pre-update' });
  hist = hist.slice(0, 30);
  fs.writeFileSync(logPath, JSON.stringify(hist, null, 2));
  return id;
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dest, name);
    if (name === 'uploads') continue;
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function apply(token, who) {
  const p = pending.get(token);
  if (!p) throw new Error('Token expired or invalid. Please check the ZIP again.');
  pending.delete(token);

  const plan = buildPlan(p.buf);
  if (plan.added + plan.changed === 0) throw new Error('Nothing to apply.');

  const backupId = makeBackup();

  for (const f of plan.files) {
    if (f.status === 'same') continue;
    const dest = path.join(ROOT, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
  }

  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  hist.unshift({
    id: 'upd_' + Date.now(),
    at: new Date().toISOString(),
    label: 'update applied',
    by: who || 'admin',
    backupId,
    added: plan.added,
    changed: plan.changed
  });
  hist = hist.slice(0, 30);
  fs.writeFileSync(logPath, JSON.stringify(hist, null, 2));

  return {
    ok: true,
    backupId,
    added: plan.added,
    changed: plan.changed,
    message: 'Update applied!'
  };
}

function rollback(backupId) {
  if (!backupId || !/^bak_\d+$/.test(backupId)) throw new Error('Invalid backup id');
  const dir = path.join(BACKUP_DIR, backupId);
  if (!fs.existsSync(dir)) throw new Error('Backup not found: ' + backupId);

  function restore(from, toRel) {
    const src = path.join(dir, toRel);
    const dest = path.join(ROOT, toRel);
    if (!fs.existsSync(src)) return;
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const name of fs.readdirSync(src)) restore(from, path.join(toRel, name));
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  for (const item of ['server.js', 'package.json', 'src', 'public']) {
    restore(dir, item);
  }

  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  hist.unshift({
    id: 'rb_' + Date.now(),
    at: new Date().toISOString(),
    label: 'rollback to ' + backupId
  });
  hist = hist.slice(0, 30);
  fs.writeFileSync(logPath, JSON.stringify(hist, null, 2));

  return { ok: true, backupId, message: 'Rollback done.' };
}

function clearHistory() {
  const logPath = path.join(BACKUP_DIR, 'history.json');
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.writeFileSync(logPath, '[]');
  return { ok: true, message: 'History cleared' };
}

function clearBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return { ok: true, deleted: 0 };
  let deleted = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!name.startsWith('bak_')) continue;
    const p = path.join(BACKUP_DIR, name);
    try {
      fs.rmSync(p, { recursive: true, force: true });
      deleted++;
    } catch {}
  }
  return { ok: true, deleted, message: deleted + ' backup(s) deleted' };
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(n => n.startsWith('bak_') && fs.statSync(path.join(BACKUP_DIR, n)).isDirectory())
    .map(id => ({ id, at: new Date(parseInt(id.replace('bak_', ''), 10) || 0).toISOString() }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

function info() {
  const logPath = path.join(BACKUP_DIR, 'history.json');
  let hist = [];
  try { hist = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
  let version = '1.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
  } catch {}
  return {
    version,
    history: hist.slice(0, 20),
    backups: listBackups().slice(0, 15),
    maxZipMB: MAX_ZIP / (1024 * 1024)
  };
}

/** Build a simple store-only ZIP of current site code (no data/uploads/node_modules) */
function exportSiteZip() {
  const files = [];
  function walk(dir, base) {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.join(base, name).replace(/\\/g, '/');
      if (isProtected(rel)) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full, rel);
      else files.push({ rel, data: fs.readFileSync(full) });
    }
  }
  walk(ROOT, '');
  // also include empty uploads keep
  files.push({ rel: 'public/uploads/.gitkeep', data: Buffer.from('') });

  // minimal ZIP writer (store only)
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.rel, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    parts.push(local, f.data);

    const cen = Buffer.alloc(46 + nameBuf.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBuf.copy(cen, 46);
    central.push(cen);
    offset += local.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, centralBuf, end]);
}

module.exports = {
  check, apply, info, listBackups, rollback, clearHistory, clearBackups, exportSiteZip, MAX_ZIP
};
