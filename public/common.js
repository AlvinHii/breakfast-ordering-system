// 共用工具：顧客頁與老闆後台都會載入
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `$${n}`;

async function api(path, { method = 'GET', body } = {}) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  const r = await fetch(path, opt);
  let data = null;
  try { data = await r.json(); } catch (_) { /* 無內容 */ }
  if (!r.ok) throw new Error((data && data.error) || `發生錯誤（${r.status}）`);
  return data;
}

function toast(msg, type = '') {
  let box = $('#toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 4200);
  setTimeout(() => el.remove(), 4700);
}

// 提示音：瀏覽器規定要使用者先點一下頁面才能播放
let audioCtx = null;
document.addEventListener('click', () => {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* 不支援 */ } }
  if (audioCtx) audioCtx.resume();
});
function beep(times = 2) {
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    const t = audioCtx.currentTime + i * 0.35;
    o.start(t); o.stop(t + 0.22);
  }
}
function askNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}
function notify(title, body, type = 'ok') {
  toast(`${title}${body ? '｜' + body : ''}`, type);
  beep();
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body }); } catch (_) { /* 部分瀏覽器不支援 */ }
  }
}

const STATUS_CLASS = { 待接單: 'st-pending', 已接單: 'st-accepted', 製作完成: 'st-ready', 已取餐: 'st-done', 已拒絕: 'st-bad', 已取消: 'st-bad' };
const statusTag = (s) => `<span class="status ${STATUS_CLASS[s] || ''}">${esc(s === '已接單' ? '已接單・製作中' : s)}</span>`;
const starText = (avg) => { const n = Math.round(avg); return '★'.repeat(n) + '☆'.repeat(5 - n); };
const timeOf = (iso) => new Date(iso).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
const lineText = (l) => `${esc(l.name)}${l.note ? `（${esc(l.note)}）` : ''} x ${l.qty}`;
const thumb = (photo, name, cls = 'ph') => photo
  ? `<img class="${cls}" src="${esc(photo)}" alt="${esc(name)}" loading="lazy">`
  : `<div class="${cls} ph-empty">${esc(String(name || '?').slice(0, 1))}</div>`;

// 客製選項：算加價與顯示文字（和伺服器的 resolveChoices 一致，伺服器會再檢查一次）
const GROUP_HINT = { one: '必選一項', maybe: '可不選，最多一項', many: '可複選' };
function calcChoices(groups, picked = {}) {
  let extra = 0; const parts = [];
  for (const g of groups || []) {
    const chosen = g.choices.filter((c) => (picked[g.name] || []).includes(c.label));
    if (!chosen.length) continue;
    extra += chosen.reduce((s, c) => s + c.price, 0);
    parts.push(chosen.map((c) => c.label + (c.price ? `+${c.price}` : '')).join('、'));
  }
  return { extra, note: parts.join('、') };
}

// 即時推播連線（Server-Sent Events），斷線會自動重連
function connectEvents(handlers) {
  const es = new EventSource('/api/events');
  for (const [ev, fn] of Object.entries(handlers)) es.addEventListener(ev, (e) => fn(JSON.parse(e.data)));
  return es;
}
