const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(url, opts = {}) {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  let d = {}; try { d = await r.json(); } catch {}
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}
function toast(msg, type) {
  let box = $('#toast'); if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  const t = document.createElement('div'); t.className = type || ''; t.textContent = msg; box.appendChild(t);
  setTimeout(() => t.remove(), 4200);
}
function fmtSize(b) { if (!b) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; }

async function renderNav(active) {
  let state = { user: null };
  try { state = await api('/api/me'); } catch {}
  const u = state.user;
  document.querySelector('header.nav').innerHTML =
    '<div class="wrap"><a class="brand" href="/"><img src="/assets/logo.png" alt="MCSTUFF logo"><span>MC<b>STUFF</b></span></a>' +
    '<nav class="links"><a href="/" class="' + (active === 'home' ? 'on' : '') + '">Home</a>' +
    '<a href="/resource-packs" class="' + (active === 'rp' ? 'on' : '') + '">Resource Packs</a>' +
    (u && u.is_admin ? '<a href="/admin" class="' + (active === 'admin' ? 'on' : '') + '">Admin</a>' : '') +
    (u ? '<button id="outBtn">Log out (' + esc(u.username) + ')</button>' : '<a href="/login">Log in</a>') + '</nav></div>';
  const out = $('#outBtn');
  if (out) out.onclick = async () => { await api('/api/logout', { method: 'POST' }); location.href = '/'; };
  return state;
}

// ---- auto restart + hard refresh (same logic as before) ----
async function getBootId() {
  try { const r = await fetch('/api/ping?_=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return null; return (await r.json()).boot || null; }
  catch { return null; }
}
function hardReload() {
  try { if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))); } catch {}
  const u = new URL(location.href); u.searchParams.set('_r', Date.now()); location.replace(u.toString());
}
async function waitForRestartAndReload(oldBoot, msg) {
  let ov = $('#restartOverlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'restartOverlay'; ov.innerHTML = '<div class="spin"></div><div id="restartMsg"></div>'; document.body.appendChild(ov); }
  $('#restartMsg').textContent = msg || 'Server restarting... page will refresh automatically.';
  ov.classList.add('show');
  const start = Date.now();
  await sleep(2000);
  while (Date.now() - start < 3 * 60 * 1000) {
    const b = await getBootId();
    if (b && b !== oldBoot) { await sleep(500); break; }
    await sleep(1500);
  }
  hardReload();
}
