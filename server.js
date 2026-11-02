'use strict';
// 北寧路早餐店系統 — 完整版（不含資料庫：資料存在 data.json）
// 只用 Node.js 內建模組，不需要 npm install。第三方登入需要 Node 18 以上（使用內建 fetch）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data.json');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const PUBLIC_DIR = path.join(ROOT, 'public');
const MAX_BODY = 4 * 1024 * 1024;          // 4 MB（含 base64 照片）
const MAX_PHOTO = 2 * 1024 * 1024;         // 照片解碼後最多 2 MB
const SESSION_MS = 7 * 24 * 3600 * 1000;   // 登入保留 7 天
const MIN_LEAD = 15;                       // 取餐時間至少在下單後 15 分鐘

const S = {
  PENDING: '待接單', ACCEPTED: '已接單', READY: '製作完成',
  PICKED: '已取餐', REJECTED: '已拒絕', CANCELLED: '已取消',
};
const ACTIVE_SALE = [S.ACCEPTED, S.READY, S.PICKED];   // 算進銷售的狀態
const FINAL = [S.PICKED, S.REJECTED, S.CANCELLED];

// 客製選項群組：one＝單選必選、maybe＝單選可不選、many＝複選。每個選項可以加價。
const GROUP_TYPES = ['one', 'maybe', 'many'];
const choices = (...list) => list.map((x) => (typeof x === 'string' ? { label: x, price: 0 } : { label: x[0], price: x[1] }));
const G_ICE = { name: '冰塊', type: 'one', choices: choices('正常冰', '少冰', '去冰', '熱') };
const G_SUGAR = { name: '甜度', type: 'one', choices: choices('正常糖', '半糖', '微糖', '無糖') };
const G_ADD = { name: '加料', type: 'many', choices: choices(['加蛋', 10], ['加起司', 10]) };

// ───────────────────────── 時間（台北時區） ─────────────────────────
function taipeiNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const toMin = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const toHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function shopState() {
  const { date, minutes } = taipeiNow();
  const s = db.settings;
  const open = toMin(s.open), close = toMin(s.close);
  const earliest = Math.ceil((minutes + MIN_LEAD) / 5) * 5;
  let reason = '';
  if (!s.accepting) reason = '店家目前暫停接單';
  else if (minutes < open) reason = `尚未營業，${s.open} 開始接單`;
  else if (earliest > close) reason = `今日已停止接單（營業至 ${s.close}）`;
  return {
    date, now: minutes, open: s.open, close: s.close, accepting: s.accepting,
    canOrder: !reason, reason, earliestPickup: reason ? null : toHHMM(earliest),
    pointRate: s.pointRate, minLead: MIN_LEAD,
  };
}

// ───────────────────────── 資料存取 ─────────────────────────
let db;
const nextId = (k) => ++db.seq[k];
// 先寫到暫存檔再改名：就算寫到一半當機，原本的 data.json 也不會壞掉
function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pw), salt, 32).toString('hex') };
}
function checkPassword(user, pw) {
  if (!user.hash) return false;
  const a = Buffer.from(hashPassword(pw, user.salt).hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seed() {
  db = {
    seq: { user: 0, menu: 0, combo: 0, order: 0, rating: 0 },
    settings: { open: '06:00', close: '21:00', accepting: true, pointRate: 30 },
    users: [], menu: [], combos: [], orders: [], ratings: [], sessions: {},
  };
  const addUser = (username, pw, name, role) => db.users.push({
    id: nextId('user'), username, name, role, points: 0, provider: 'local',
    ...hashPassword(pw), createdAt: new Date().toISOString(),
  });
  addUser('boss', process.env.BOSS_PASSWORD || 'boss1234', '老闆', 'boss');
  addUser('demo', 'demo1234', '示範同學', 'customer');

  const addItem = (name, price, category, desc, groups = []) => db.menu.push({
    id: nextId('menu'), name, price, category, desc, groups, photo: '', available: true,
  });
  const G_SAUCE = { name: '醬料', type: 'one', choices: choices('醬油膏', '辣椒醬', '醬油膏＋辣', '不加醬') };
  const G_NO = { name: '其他', type: 'many', choices: choices('不要美乃滋', '不要小黃瓜') };
  addItem('蛋餅', 35, '蛋餅', '現煎餅皮加蛋，外酥內軟',
    [{ name: '加料', type: 'many', choices: choices(['加蛋', 10], ['加起司', 10], ['加玉米', 10]) }, G_SAUCE]);
  addItem('火腿蛋堡', 45, '漢堡吐司', '火腿、荷包蛋夾入烤過的漢堡麵包', [G_ADD, G_NO]);
  addItem('火腿蛋吐司', 40, '漢堡吐司', '火腿、荷包蛋與吐司', [G_ADD, G_NO, { name: '吐司', type: 'maybe', choices: choices('去邊', ['加厚片', 5]) }]);
  addItem('奶茶', 25, '飲料', '店內自煮紅茶加奶', [G_ICE, G_SUGAR]);
  addItem('紅茶', 20, '飲料', '古早味紅茶', [G_ICE, G_SUGAR]);
  addItem('豆漿', 20, '飲料', '無糖豆漿', [{ name: '溫度', type: 'one', choices: choices('冰', '熱') }]);
  db.combos.push({
    id: nextId('combo'), name: '早八套餐', price: 65, desc: '火腿蛋堡＋奶茶，奶茶冰塊甜度可選',
    items: [{ ref: 2, qty: 1 }, { ref: 4, qty: 1 }], photo: '', available: true,
  });
}

function load() {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  else { seed(); save(); }
  // 舊版資料：options（單一選項清單）自動轉成選項群組
  let migrated = false;
  for (const m of db.menu) {
    if (!Array.isArray(m.groups)) {
      const old = Array.isArray(m.options) ? m.options : [];
      m.groups = old.length ? [{ name: '選項', type: 'one', choices: choices(...old) }] : [];
      delete m.options;
      migrated = true;
    }
  }
  if (migrated) save();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const publicUser = (u) => u && ({ id: u.id, username: u.username, name: u.name, role: u.role, points: u.points, provider: u.provider });

// ───────────────────────── 工具 ─────────────────────────
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name, value, maxAgeSec) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
function sessionUser(req) {
  const sid = parseCookies(req).sid;
  const s = sid && db.sessions[sid];
  if (!s) return null;
  if (s.exp < Date.now()) { delete db.sessions[sid]; return null; }
  return db.users.find((u) => u.id === s.userId) || null;
}
function startSession(res, user) {
  const sid = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  for (const [k, v] of Object.entries(db.sessions)) if (v.exp < now) delete db.sessions[k];
  db.sessions[sid] = { userId: user.id, exp: now + SESSION_MS };
  save();
  res.setHeader('Set-Cookie', cookie('sid', sid, SESSION_MS / 1000));
}

const str = (v, max, label, { required = true } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) fail(400, `請填寫${label}`);
  if (s.length > max) fail(400, `${label}最多 ${max} 個字`);
  return s;
};
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(400, `${label}需為 ${min}–${max} 的整數`);
  return n;
};
const photoPath = (v) => {
  const s = String(v || '');
  if (s && !/^\/uploads\/[a-f0-9]{24}\.(png|jpg|webp|gif)$/.test(s)) fail(400, '照片路徑不正確');
  return s;
};

// ───────────────────────── 即時推播（Server-Sent Events） ─────────────────────────
const clients = new Set();
function push(cl, event, data) { cl.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
function emitOrder(o) {
  for (const cl of clients) if (cl.user.role === 'boss' || cl.user.id === o.userId) push(cl, 'order', o);
}
function emitUser(u) { for (const cl of clients) if (cl.user.id === u.id) push(cl, 'me', publicUser(u)); }
function emitMenu() { for (const cl of clients) push(cl, 'menu', {}); }
setInterval(() => { for (const cl of clients) cl.res.write(': ping\n\n'); }, 25000).unref();

// ───────────────────────── 訂單邏輯 ─────────────────────────
function setStatus(o, status) {
  o.status = status;
  o.history.push({ status, at: new Date().toISOString() });
}
function refund(o, { deductEarned = false } = {}) {
  const u = db.users.find((x) => x.id === o.userId);
  if (!u) return;
  let delta = o.pointsUsed;
  if (deductEarned && o.pointsEarned) { delta -= o.pointsEarned; o.pointsEarned = 0; }
  if (delta) { u.points = Math.max(0, u.points + delta); emitUser(u); }
}
function getOrder(id) { return db.orders.find((o) => o.id === Number(id)) || fail(404, '找不到訂單'); }

// 檢查顧客選的客製選項，算出加價和要印在訂單上的文字
function resolveChoices(m, picked) {
  const src = picked && typeof picked === 'object' && !Array.isArray(picked) ? picked : {};
  let extra = 0; const parts = []; const clean = {};
  for (const g of m.groups) {
    const want = Array.isArray(src[g.name]) ? [...new Set(src[g.name].map(String))] : [];
    const chosen = g.choices.filter((c) => want.includes(c.label));
    if (chosen.length !== want.length) fail(400, `「${m.name}」的「${g.name}」選項不正確，請重新選擇`);
    if (g.type === 'one' && chosen.length !== 1) fail(400, `請選擇「${m.name}」的${g.name}`);
    if (g.type === 'maybe' && chosen.length > 1) fail(400, `「${m.name}」的${g.name}只能選一個`);
    if (!chosen.length) continue;
    clean[g.name] = chosen.map((c) => c.label);
    parts.push(chosen.map((c) => c.label + (c.price ? `+${c.price}` : '')).join('、'));
    extra += chosen.reduce((s, c) => s + c.price, 0);
  }
  return { extra, note: parts.join('、'), choices: clean };
}

// 取餐時間到了還沒接單的訂單，自動取消並退回點數
function expireOrders() {
  const { date, minutes } = taipeiNow();
  let changed = false;
  for (const o of db.orders) {
    if (o.status !== S.PENDING) continue;
    if (o.date < date || (o.date === date && toMin(o.pickupTime) <= minutes)) {
      o.cancelReason = '店家未在取餐時間前接單，系統已自動取消';
      setStatus(o, S.CANCELLED);
      refund(o);
      emitOrder(o);
      changed = true;
    }
  }
  if (changed) save();
}
setInterval(expireOrders, 30 * 1000).unref();

// 登入失敗太多次就暫時鎖住（防止有人一直猜密碼）
const LOGIN_MAX = 5, LOGIN_WINDOW = 10 * 60 * 1000;
const loginFails = new Map();
function loginKey(req, username) { return `${req.socket.remoteAddress}|${String(username || '').toLowerCase()}`; }
function checkLoginLock(key) {
  const f = loginFails.get(key);
  if (f && f.count >= LOGIN_MAX && Date.now() - f.first < LOGIN_WINDOW) {
    fail(429, `登入失敗太多次，請 ${Math.ceil((LOGIN_WINDOW - (Date.now() - f.first)) / 60000)} 分鐘後再試`);
  }
}
function recordLoginFail(key) {
  const f = loginFails.get(key);
  if (!f || Date.now() - f.first >= LOGIN_WINDOW) loginFails.set(key, { count: 1, first: Date.now() });
  else f.count++;
}

function ratingSummary() {
  const out = {};
  for (const r of db.ratings) {
    const s = out[r.ref] || (out[r.ref] = { sum: 0, count: 0, dist: [0, 0, 0, 0, 0, 0] });
    s.sum += r.stars; s.count++; s.dist[r.stars]++;
  }
  for (const s of Object.values(out)) { s.avg = Math.round((s.sum / s.count) * 10) / 10; delete s.sum; }
  return out;
}
function salesBy(orders) {
  const out = {};
  for (const o of orders) for (const l of o.items) {
    const ref = `${l.type}:${l.ref}`;
    const s = out[ref] || (out[ref] = { ref, name: l.name, qty: 0, revenue: 0 });
    s.qty += l.qty; s.revenue += l.price * l.qty;
  }
  return out;
}
function refInfo(ref) {
  const [type, id] = ref.split(':');
  if (type === 'combo') { const c = db.combos.find((x) => x.id === Number(id)); return { name: c ? c.name : '(已刪除套餐)', category: '套餐' }; }
  const m = db.menu.find((x) => x.id === Number(id));
  return { name: m ? m.name : '(已刪除餐點)', category: m ? m.category : '-' };
}

// ───────────────────────── 路由 ─────────────────────────
const routes = [];
function route(method, pattern, handler, auth = null) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth });
}

// 帳號
route('GET', '/api/me', (c) => publicUser(c.user) || null);

route('POST', '/api/register', (c) => {
  const username = str(c.body.username, 20, '帳號');
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) fail(400, '帳號需為 3–20 個英數字或底線');
  const password = String(c.body.password || '');
  if (password.length < 6) fail(400, '密碼至少 6 個字元');
  const name = str(c.body.name, 20, '暱稱');
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) fail(409, '這個帳號已被註冊');
  const u = { id: nextId('user'), username, name, role: 'customer', points: 0, provider: 'local', ...hashPassword(password), createdAt: new Date().toISOString() };
  db.users.push(u);
  startSession(c.res, u);
  return publicUser(u);
});

route('POST', '/api/login', (c) => {
  const key = loginKey(c.req, c.body.username);
  checkLoginLock(key);
  const u = db.users.find((x) => x.username.toLowerCase() === String(c.body.username || '').toLowerCase());
  if (!u || !checkPassword(u, c.body.password)) { recordLoginFail(key); fail(401, '帳號或密碼錯誤'); }
  loginFails.delete(key);
  startSession(c.res, u);
  return publicUser(u);
});

route('POST', '/api/logout', (c) => {
  const sid = parseCookies(c.req).sid;
  if (sid && db.sessions[sid]) { delete db.sessions[sid]; save(); }
  c.res.setHeader('Set-Cookie', cookie('sid', '', 0));
  return { ok: true };
});

// 菜單（任何人可看）
route('GET', '/api/menu', () => {
  const st = shopState();
  const month = st.date.slice(0, 7);
  const sales = Object.values(salesBy(db.orders.filter((o) => o.date.startsWith(month) && ACTIVE_SALE.includes(o.status))));
  const popular = sales.filter((s) => s.qty > 0).sort((a, b) => b.qty - a.qty).slice(0, 3).map((s) => s.ref);
  return {
    shop: st,
    menu: db.menu.filter((m) => m.available),
    combos: db.combos.filter((c) => c.available).map((c) => ({
      ...c, contents: c.items.map((i) => { const m = db.menu.find((x) => x.id === i.ref) || {}; return { ...i, name: m.name || '?', groups: m.groups || [] }; }),
    })),
    ratings: ratingSummary(),
    popular,
  };
});

route('GET', '/api/ratings/:ref', (c) => {
  const ref = decodeURIComponent(c.params.ref);
  return db.ratings.filter((r) => r.ref === ref).slice(-30).reverse().map((r) => ({
    stars: r.stars, comment: r.comment, createdAt: r.createdAt,
    name: ((db.users.find((u) => u.id === r.userId) || {}).name || '顧客').replace(/^(.).*$/, '$1**'),
  }));
});

// 顧客：下單、查詢、取消、評價
route('POST', '/api/orders', (c) => {
  const st = shopState();
  if (!st.canOrder) fail(400, st.reason);
  const items = Array.isArray(c.body.items) ? c.body.items : [];
  if (!items.length) fail(400, '訂單沒有餐點');
  if (items.length > 50) fail(400, '品項太多');
  const lines = items.map((it) => {
    const qty = int(it.qty, 1, 20, '數量');
    if (it.type === 'combo') {
      const cb = db.combos.find((x) => x.id === Number(it.ref) && x.available) || fail(400, '套餐不存在或已下架');
      const sent = Array.isArray(it.parts) ? it.parts : [];
      let extra = 0; const notes = []; const parts = [];
      cb.items.forEach((ci, k) => {
        const m = db.menu.find((x) => x.id === ci.ref);
        if (!m || !m.available) fail(400, `套餐「${cb.name}」裡的${m ? `「${m.name}」` : '餐點'}目前售完`);
        const r = resolveChoices(m, sent[k]);
        extra += r.extra * ci.qty;
        parts.push(r.choices);
        if (r.note) notes.push(`${m.name}：${r.note}`);
      });
      return { type: 'combo', ref: cb.id, name: cb.name, price: cb.price + extra, qty, note: notes.join('；'), parts };
    }
    const m = db.menu.find((x) => x.id === Number(it.ref) && x.available) || fail(400, '餐點不存在或已下架');
    const r = resolveChoices(m, it.choices);
    return { type: 'item', ref: m.id, name: m.name, price: m.price + r.extra, qty, note: r.note, choices: r.choices };
  });

  const pmin = toMin(c.body.pickupTime);
  if (pmin === null) fail(400, '請選擇取餐時間');
  if (pmin < st.now + MIN_LEAD) fail(400, `取餐時間至少需間隔${MIN_LEAD}分鐘`);
  if (pmin > toMin(st.close)) fail(400, `取餐時間需在今日營業時間內（${st.open}–${st.close}）`);

  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  let usePoints = Math.max(0, Math.floor(Number(c.body.usePoints) || 0));
  if (usePoints > c.user.points) fail(400, '點數不足');
  usePoints = Math.min(usePoints, subtotal);
  c.user.points -= usePoints;

  const now = new Date().toISOString();
  const o = {
    id: nextId('order'), userId: c.user.id, customerName: c.user.name, items: lines,
    subtotal, pointsUsed: usePoints, total: subtotal - usePoints, pointsEarned: 0,
    pickupTime: toHHMM(pmin), date: st.date, status: S.PENDING, number: null,
    rejectReason: '', rated: false, createdAt: now, history: [{ status: S.PENDING, at: now }],
  };
  db.orders.push(o);
  save();
  emitOrder(o);
  if (usePoints) emitUser(c.user);
  c.status = 201;
  return o;
}, 'customer');

route('GET', '/api/my/orders', (c) => db.orders.filter((o) => o.userId === c.user.id).slice(-50).reverse(), 'customer');

route('POST', '/api/orders/:id/cancel', (c) => {
  const o = getOrder(c.params.id);
  if (o.userId !== c.user.id) fail(404, '找不到訂單');
  if (o.status !== S.PENDING) fail(400, '店家已處理這筆訂單，無法取消，請聯絡店家');
  setStatus(o, S.CANCELLED);
  refund(o);
  save(); emitOrder(o);
  return o;
}, 'customer');

route('POST', '/api/orders/:id/rate', (c) => {
  const o = getOrder(c.params.id);
  if (o.userId !== c.user.id) fail(404, '找不到訂單');
  if (![S.READY, S.PICKED].includes(o.status)) fail(400, '餐點完成後才能評價');
  if (o.rated) fail(400, '這筆訂單已經評價過了');
  const allowed = new Set(o.items.map((l) => `${l.type}:${l.ref}`));
  const list = Array.isArray(c.body.ratings) ? c.body.ratings : [];
  if (!list.length) fail(400, '請至少評價一項餐點');
  const seen = new Set();
  const rows = list.map((r) => {
    const ref = String(r.ref);
    if (!allowed.has(ref) || seen.has(ref)) fail(400, '評價的餐點不在這筆訂單中');
    seen.add(ref);
    return { id: nextId('rating'), orderId: o.id, userId: c.user.id, ref, stars: int(r.stars, 0, 5, '星等'), comment: str(r.comment, 200, '評論', { required: false }), createdAt: new Date().toISOString() };
  });
  db.ratings.push(...rows);
  o.rated = true;
  save(); emitOrder(o); emitMenu();
  return o;
}, 'customer');

// 即時推播
route('GET', '/api/events', (c) => {
  c.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  c.res.write('retry: 3000\n\n');
  const cl = { res: c.res, user: c.user };
  clients.add(cl);
  c.req.on('close', () => clients.delete(cl));
  return undefined;   // 保持連線
}, 'user');

// 老闆：訂單
route('GET', '/api/boss/orders', () => {
  const today = taipeiNow().date;
  return db.orders.filter((o) => o.date === today || !FINAL.includes(o.status));
}, 'boss');

route('POST', '/api/boss/orders/:id/accept', (c) => {
  const o = getOrder(c.params.id);
  if (o.status !== S.PENDING) fail(400, `訂單目前為「${o.status}」，無法接單`);
  const { date, minutes } = taipeiNow();
  if (o.date < date || (o.date === date && toMin(o.pickupTime) <= minutes)) {
    expireOrders();
    fail(400, '這筆訂單的取餐時間已經過了，系統已自動取消');
  }
  const n = db.orders.filter((x) => x.date === o.date && x.number).length + 1;
  o.number = 'A' + String(n).padStart(2, '0');
  setStatus(o, S.ACCEPTED);
  save(); emitOrder(o);
  return o;
}, 'boss');

route('POST', '/api/boss/orders/:id/reject', (c) => {
  const o = getOrder(c.params.id);
  if (o.status !== S.PENDING) fail(400, `訂單目前為「${o.status}」，無法拒絕`);
  o.rejectReason = str(c.body.reason, 50, '拒絕原因', { required: false }) || '店家無法接單';
  setStatus(o, S.REJECTED);
  refund(o);
  save(); emitOrder(o);
  return o;
}, 'boss');

route('POST', '/api/boss/orders/:id/status', (c) => {
  const o = getOrder(c.params.id);
  const to = c.body.status;
  if (to === S.READY && o.status === S.ACCEPTED) setStatus(o, S.READY);
  else if (to === S.PICKED && o.status === S.READY) {
    setStatus(o, S.PICKED);
    const u = db.users.find((x) => x.id === o.userId);
    o.pointsEarned = Math.floor(o.total / db.settings.pointRate);
    if (u && o.pointsEarned) { u.points += o.pointsEarned; emitUser(u); }
  } else fail(400, `無法從「${o.status}」改為「${to}」`);
  save(); emitOrder(o);
  return o;
}, 'boss');

route('POST', '/api/boss/orders/:id/cancel', (c) => {
  const o = getOrder(c.params.id);
  if ([S.REJECTED, S.CANCELLED].includes(o.status)) fail(400, '訂單已經結束');
  setStatus(o, S.CANCELLED);
  refund(o, { deductEarned: true });   // 退回使用的點數，並扣回這筆訂單產生的點數
  save(); emitOrder(o);
  return o;
}, 'boss');

// 老闆：照片上傳
route('POST', '/api/boss/upload', (c) => {
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(String(c.body.dataUrl || ''));
  if (!m) fail(400, '只接受 PNG、JPG、WEBP、GIF 圖片');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > MAX_PHOTO) fail(400, '照片太大（上限 2 MB）');
  const name = `${crypto.randomBytes(12).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return { url: `/uploads/${name}` };
}, 'boss');

// 老闆：餐點
function readGroups(raw) {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > 6) fail(400, '客製選項群組最多 6 組');
  const names = new Set();
  return list.map((g) => {
    const name = str(g && g.name, 10, '群組名稱');
    if (names.has(name)) fail(400, `群組名稱「${name}」重複了`);
    names.add(name);
    if (!GROUP_TYPES.includes(g.type)) fail(400, `「${name}」的選擇方式不正確`);
    const cs = Array.isArray(g.choices) ? g.choices : [];
    if (!cs.length) fail(400, `「${name}」至少要有一個選項`);
    if (cs.length > 12) fail(400, `「${name}」最多 12 個選項`);
    const labels = new Set();
    return {
      name, type: g.type,
      choices: cs.map((c) => {
        const label = str(c && c.label, 12, `「${name}」的選項`);
        if (labels.has(label)) fail(400, `「${name}」有重複的選項「${label}」`);
        labels.add(label);
        return { label, price: int(c.price ?? 0, 0, 500, `「${label}」加價`) };
      }),
    };
  });
}
function readItem(b) {
  return {
    name: str(b.name, 30, '餐點名稱'), price: int(b.price, 1, 9999, '單價'),
    category: str(b.category, 20, '分類'), desc: str(b.desc, 200, '說明', { required: false }),
    groups: readGroups(b.groups), photo: photoPath(b.photo), available: b.available !== false,
  };
}
route('GET', '/api/boss/menu', () => ({ menu: db.menu, combos: db.combos }), 'boss');
route('POST', '/api/boss/menu', (c) => {
  const m = { id: nextId('menu'), ...readItem(c.body) };
  db.menu.push(m); save(); emitMenu(); c.status = 201; return m;
}, 'boss');
route('PUT', '/api/boss/menu/:id', (c) => {
  const m = db.menu.find((x) => x.id === Number(c.params.id)) || fail(404, '找不到餐點');
  Object.assign(m, readItem(c.body)); save(); emitMenu(); return m;
}, 'boss');
route('DELETE', '/api/boss/menu/:id', (c) => {
  const id = Number(c.params.id);
  const used = db.combos.filter((cb) => cb.items.some((i) => i.ref === id));
  if (used.length) fail(400, `這道餐點在套餐「${used.map((x) => x.name).join('、')}」中，請先修改套餐，或改成下架`);
  const i = db.menu.findIndex((x) => x.id === id);
  if (i < 0) fail(404, '找不到餐點');
  db.menu.splice(i, 1); save(); emitMenu(); return { ok: true };
}, 'boss');

// 老闆：套餐
function readCombo(b) {
  const items = (Array.isArray(b.items) ? b.items : []).map((i) => {
    const ref = Number(i.ref);
    if (!db.menu.some((m) => m.id === ref)) fail(400, '套餐包含不存在的餐點');
    return { ref, qty: int(i.qty, 1, 10, '套餐內數量') };
  });
  if (!items.length) fail(400, '套餐至少要包含一項餐點');
  return {
    name: str(b.name, 30, '套餐名稱'), price: int(b.price, 1, 9999, '套餐價格'),
    desc: str(b.desc, 200, '說明', { required: false }), items, photo: photoPath(b.photo), available: b.available !== false,
  };
}
route('POST', '/api/boss/combos', (c) => {
  const cb = { id: nextId('combo'), ...readCombo(c.body) };
  db.combos.push(cb); save(); emitMenu(); c.status = 201; return cb;
}, 'boss');
route('PUT', '/api/boss/combos/:id', (c) => {
  const cb = db.combos.find((x) => x.id === Number(c.params.id)) || fail(404, '找不到套餐');
  Object.assign(cb, readCombo(c.body)); save(); emitMenu(); return cb;
}, 'boss');
route('DELETE', '/api/boss/combos/:id', (c) => {
  const i = db.combos.findIndex((x) => x.id === Number(c.params.id));
  if (i < 0) fail(404, '找不到套餐');
  db.combos.splice(i, 1); save(); emitMenu(); return { ok: true };
}, 'boss');

// 老闆：設定
route('GET', '/api/boss/settings', () => db.settings, 'boss');
route('PUT', '/api/boss/settings', (c) => {
  const b = c.body;
  const open = toMin(b.open), close = toMin(b.close);
  if (open === null || close === null) fail(400, '營業時間格式需為 HH:MM');
  if (open >= close) fail(400, '打烊時間需晚於開店時間');
  db.settings = { open: b.open, close: b.close, accepting: !!b.accepting, pointRate: int(b.pointRate, 1, 1000, '點數門檻') };
  save(); emitMenu(); return db.settings;
}, 'boss');

// 老闆：銷售統計
route('GET', '/api/boss/stats', (c) => {
  const { date } = taipeiNow();
  const range = c.query.get('range') || 'today';
  const inRange = (o) => range === 'all' || (range === 'month' ? o.date.startsWith(date.slice(0, 7)) : o.date === date);
  const scoped = db.orders.filter(inRange);
  const sold = scoped.filter((o) => ACTIVE_SALE.includes(o.status));
  const items = Object.values(salesBy(sold)).map((s) => ({ ...s, ...refInfo(s.ref) })).sort((a, b) => b.qty - a.qty);
  const summary = ratingSummary();
  const ratings = Object.entries(summary).map(([ref, s]) => ({ ref, ...refInfo(ref), ...s })).sort((a, b) => b.avg - a.avg || b.count - a.count);
  const statusCounts = {};
  for (const o of scoped) statusCounts[o.status] = (statusCounts[o.status] || 0) + 1;
  const revenue = sold.reduce((s, o) => s + o.total, 0);
  return {
    range, orders: sold.length, revenue, avgOrder: sold.length ? Math.round(revenue / sold.length) : 0,
    pointsUsed: sold.reduce((s, o) => s + o.pointsUsed, 0), items, ratings, statusCounts,
  };
}, 'boss');

// ───────────────────────── 第三方登入（OAuth 2.0） ─────────────────────────
const PROVIDERS = {
  github: {
    label: 'GitHub', id: process.env.GITHUB_CLIENT_ID, secret: process.env.GITHUB_CLIENT_SECRET,
    authUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
    userUrl: 'https://api.github.com/user', scope: 'read:user',
    profile: (p) => ({ pid: String(p.id), name: p.name || p.login }),
  },
  google: {
    label: 'Google', id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth', tokenUrl: 'https://oauth2.googleapis.com/token',
    userUrl: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid profile',
    profile: (p) => ({ pid: String(p.sub), name: p.name || 'Google 使用者' }),
  },
};
route('GET', '/api/auth/providers', () => Object.fromEntries(Object.entries(PROVIDERS).map(([k, p]) => [k, { label: p.label, enabled: !!(p.id && p.secret) }])));

route('GET', '/auth/:provider', (c) => {
  const p = PROVIDERS[c.params.provider] || fail(404, '不支援的登入方式');
  if (!p.id || !p.secret) fail(400, `${p.label} 登入尚未設定（請設定環境變數，見 README）`);
  const state = crypto.randomBytes(16).toString('hex');
  const q = new URLSearchParams({ client_id: p.id, redirect_uri: `${BASE_URL}/auth/${c.params.provider}/callback`, scope: p.scope, state, response_type: 'code' });
  c.res.writeHead(302, { Location: `${p.authUrl}?${q}`, 'Set-Cookie': cookie('oauth_state', state, 600) });
  c.res.end();
});

route('GET', '/auth/:provider/callback', async (c) => {
  const name = c.params.provider;
  const p = PROVIDERS[name] || fail(404, '不支援的登入方式');
  const code = c.query.get('code');
  const state = c.query.get('state');
  if (!code || !state || state !== parseCookies(c.req).oauth_state) fail(400, '登入驗證失敗，請重新登入');
  if (typeof fetch !== 'function') fail(500, '第三方登入需要 Node.js 18 以上');
  const tokRes = await fetch(p.tokenUrl, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: p.id, client_secret: p.secret, code, grant_type: 'authorization_code', redirect_uri: `${BASE_URL}/auth/${name}/callback` }),
  });
  const tok = await tokRes.json().catch(() => ({}));
  if (!tok.access_token) fail(400, `${p.label} 登入失敗`);
  const prof = await (await fetch(p.userUrl, { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'breakfast-shop', Accept: 'application/json' } })).json();
  const { pid, name: display } = p.profile(prof);
  let u = db.users.find((x) => x.provider === name && x.providerId === pid);
  if (!u) {
    u = { id: nextId('user'), username: `${name}_${pid}`, name: String(display).slice(0, 20), role: 'customer', points: 0, provider: name, providerId: pid, createdAt: new Date().toISOString() };
    db.users.push(u);
  }
  startSession(c.res, u);
  c.res.writeHead(302, { Location: '/' });
  c.res.end();
});

// ───────────────────────── 靜態檔案 ─────────────────────────
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const PAGES = { '/': 'index.html', '/boss': 'boss.html', '/shop': 'boss.html', '/style.css': 'style.css', '/common.js': 'common.js' };

function serveStatic(pathname, res) {
  let file = null;
  if (PAGES[pathname]) file = path.join(PUBLIC_DIR, PAGES[pathname]);
  else {
    const m = /^\/uploads\/([a-f0-9]{24}\.(png|jpg|webp|gif))$/.exec(pathname);
    if (m) file = path.join(UPLOAD_DIR, m[1]);
  }
  if (!file || !fs.existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
  return true;
}

// ───────────────────────── 伺服器 ─────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (ch) => {
      size += ch.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '資料太大')); req.destroy(); } else chunks.push(ch);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return sendJson(res, 404, { error: '找不到這個頁面' });

    const user = sessionUser(req);
    if (r.auth && !user) fail(401, '請先登入');
    if (r.auth === 'boss' && user.role !== 'boss') fail(403, '只有老闆可以使用這個功能');
    if (r.auth === 'customer' && user.role !== 'customer') fail(403, '請使用顧客帳號');

    let body = {};
    if (req.method !== 'GET') {
      // 只接受 JSON，搭配 SameSite cookie 防止跨站偽造請求
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, '請以 JSON 送出');
      const raw = await readBody(req);
      try { body = raw ? JSON.parse(raw) : {}; } catch { fail(400, '資料格式錯誤'); }
      if (!body || typeof body !== 'object') body = {};
    }
    const params = {};
    const m = r.re.exec(url.pathname);
    r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
    const c = { req, res, params, query: url.searchParams, body, user, status: 200 };
    const out = await r.handler(c);
    if (out === undefined) return;              // 已自行回應（推播、轉址）
    sendJson(res, c.status, out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (res.headersSent) return res.end();
    const status = e instanceof HttpError ? e.status : 500;
    const msg = e instanceof HttpError ? e.message : '伺服器發生錯誤';
    if (url.pathname.startsWith('/auth/')) {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<meta charset="utf-8"><p style="font-family:sans-serif">${msg.replace(/[<>&]/g, '')}</p><a href="/">回首頁</a>`);
    }
    sendJson(res, status, { error: msg });
  }
});

load();
expireOrders();
server.listen(PORT, () => {
  console.log(`北寧路早餐店系統已啟動`);
  console.log(`  顧客點餐： ${BASE_URL}/`);
  console.log(`  老闆後台： ${BASE_URL}/boss`);
  console.log(`  示範帳號： 老闆 boss / ${process.env.BOSS_PASSWORD ? '(BOSS_PASSWORD)' : 'boss1234'}　顧客 demo / demo1234`);
});
