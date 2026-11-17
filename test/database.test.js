'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { databaseConfig } = require('../config');
const { Storage } = require('../storage');
const root = path.join(__dirname, '..');

test('PostgreSQL migration, order lifecycle, atomicity and restart persistence', { timeout: 240000 }, async t => {
  const suffix = crypto.randomBytes(6).toString('hex');
  const schema = `test_breakfast_${suffix}`;
  const importedSchema = `${schema}_import`;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'breakfast-pg-test-'));
  const config = { ...databaseConfig(), schema };
  const storage = new Storage(config);
  const imported = new Storage({ ...config, schema: importedSchema });
  const processes = new Set();
  let app;
  async function start(targetSchema = schema, legacyFile = path.join(scratch, 'absent.json'), overrides = {}) {
    const child = fork(path.join(root, 'server.js'), [], {
      cwd: root,
      env: { ...process.env, NODE_ENV: 'test', PORT: '0', DB_SCHEMA: targetSchema, BOSS_PASSWORD: 'testboss1234', LEGACY_DATA_FILE: legacyFile, UPLOAD_DIR: path.join(scratch, 'uploads'), ...overrides },
      execArgv: ['--require', path.join(__dirname, 'clock.cjs')],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    processes.add(child);
    let diagnostic = '';
    child.stderr.on('data', b => { diagnostic += b.toString(); });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('測試服務啟動逾時')), 45000);
      child.once('message', message => { clearTimeout(timer); resolve(message.port); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`測試服務未能啟動 (${code})：${diagnostic}`)); });
    });
    return { child, url: `http://127.0.0.1:${port}` };
  }
  async function stop(instance) {
    if (!instance || instance.child.exitCode !== null) return;
    const exited = once(instance.child, 'exit');
    instance.child.kill();
    await exited;
    processes.delete(instance.child);
  }
  async function api(route, { cookie, body, method = body === undefined ? 'GET' : 'POST', status = 200, instance = app } = {}) {
    const response = await fetch(instance.url + route, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    const value = await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(value)}`);
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  t.after(async () => {
    for (const child of processes) { if (child.exitCode !== null || child.signalCode) continue; const exit = once(child, 'exit'); child.kill(); await exit; }
    // 僅刪除這次測試自行建立、名稱已驗證的 schema。
    for (const name of [schema, importedSchema]) {
      assert.match(name, /^test_breakfast_[a-f0-9]{12}(_import)?$/);
      await storage.pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    }
    await storage.close();
    await imported.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  app = await start();
  let boss, customer, orderId, secondOrderId;
  await t.test('seeds schema, validates credentials and enforces roles', async () => {
    const menu = (await api('/api/menu')).value;
    assert.equal(menu.menu.length, 6);
    assert.equal(menu.combos.length, 1);
    await api('/api/boss/orders', { status: 401 });
    await api('/api/login', { body: { username: 'boss', password: 'wrong' }, status: 401 });
    boss = (await api('/api/login', { body: { username: 'boss', password: 'testboss1234' } })).cookie;
    customer = (await api('/api/register', { body: { username: 'student', password: 'student1234', name: '測試同學' } })).cookie;
    await api('/api/boss/orders', { cookie: customer, status: 403 });
    await api('/api/register', { body: { username: 'STUDENT', password: 'student1234', name: '重複' }, status: 409 });
  });
  await t.test('menu, combo and settings edits persist to SQL tables', async () => {
    const item = (await api('/api/boss/menu', { cookie: boss, body: { name: '測試餐點', price: 50, category: '測試', desc: '', groups: [], photo: '' }, status: 201 })).value;
    const combo = (await api('/api/boss/combos', { cookie: boss, body: { name: '測試套餐', price: 45, desc: '', photo: '', items: [{ ref: item.id, qty: 1 }] }, status: 201 })).value;
    await api(`/api/boss/menu/${item.id}`, { cookie: boss, method: 'DELETE', body: {}, status: 400 });
    await api(`/api/boss/combos/${combo.id}`, { cookie: boss, method: 'DELETE', body: {} });
    await api(`/api/boss/menu/${item.id}`, { cookie: boss, method: 'DELETE', body: {} });
    await api('/api/boss/settings', { cookie: boss, method: 'PUT', body: { open: '00:00', close: '23:59', accepting: true, pointRate: 30 } });
    const count = await storage.pool.query(`SELECT count(*)::int AS n FROM "${schema}".menu`);
    assert.equal(count.rows[0].n, 6);
  });
  await t.test('uploaded photos persist in PostgreSQL across server restarts', async () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2uoAAAAASUVORK5CYII=', 'base64');
    await api('/api/boss/upload', { cookie: customer, body: { dataUrl: 'data:image/png;base64,' + bytes.toString('base64') }, status: 403 });
    const photo = (await api('/api/boss/upload', { cookie: boss, body: { dataUrl: 'data:image/png;base64,' + bytes.toString('base64') } })).value;
    assert.equal(fs.existsSync(path.join(scratch, 'uploads', photo.url.split('/').pop())), false);
    await stop(app);
    app = await start();
    const response = await fetch(app.url + photo.url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const health = await api('/healthz');
    assert.equal(health.value.status, 'ok');
  });
  const orderBody = { items: [{ type: 'item', ref: 4, qty: 3, choices: { '冰塊': ['少冰'], '甜度': ['無糖'] } }], pickupTime: '09:00', usePoints: 0, remark: '飲料分開裝' };
  await t.test('sold-out state survives restart and blocks items and combos', async () => {
    await api('/api/boss/menu/4/soldout', { cookie: boss, body: { soldOut: true } });
    await stop(app);
    app = await start();
    const menu = (await api('/api/menu')).value;
    assert.equal(menu.menu.find(item => item.id === 4).soldOut, true);
    assert.equal(menu.combos[0].soldOut, true);
    await api('/api/orders', { cookie: customer, body: orderBody, status: 400 });
    await api('/api/orders', { cookie: customer, body: { ...orderBody, items: [{ type: 'combo', ref: 1, qty: 1 }] }, status: 400 });
    await api('/api/boss/menu/4/soldout', { cookie: boss, body: { soldOut: false } });
    await api('/api/orders', { cookie: customer, body: { ...orderBody, remark: '字'.repeat(51) }, status: 400 });
  });
  await t.test('SSE delivers an order only after database commit', async () => {
    const controller = new AbortController();
    const stream = await fetch(app.url + '/api/events', { headers: { Cookie: boss }, signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const created = await api('/api/orders', { cookie: customer, body: orderBody, status: 201 });
    orderId = created.value.id;
    assert.equal(created.value.status, '待接單');
    assert.equal(created.value.number, null);
    assert.equal(created.value.total, 75);
    assert.equal(created.value.remark, '飲料分開裝');
    let message = '';
    const deadline = setTimeout(() => controller.abort(), 10000);
    try {
      while (!message.includes('event: order')) {
        const { value, done } = await reader.read();
        if (done) break;
        message += new TextDecoder().decode(value);
      }
      assert.match(message, /event: order/);
      const persisted = await storage.pool.query(`SELECT status FROM "${schema}".orders WHERE id=$1`, [orderId]);
      assert.equal(persisted.rows[0].status, '待接單');
    } finally { clearTimeout(deadline); controller.abort(); }
  });
  await t.test('accepts, completes, awards points and stores ratings', async () => {
    const accepted = (await api(`/api/boss/orders/${orderId}/accept`, { cookie: boss, body: {} })).value;
    assert.equal(accepted.number, 'A01');
    await api(`/api/orders/${orderId}/cancel`, { cookie: customer, body: {}, status: 400 });
    await api(`/api/boss/orders/${orderId}/status`, { cookie: boss, body: { status: '製作完成' } });
    await api(`/api/boss/orders/${orderId}/status`, { cookie: boss, body: { status: '已取餐' } });
    assert.equal((await api('/api/me', { cookie: customer })).value.points, 2);
    await api(`/api/orders/${orderId}/rate`, { cookie: customer, body: { ratings: [{ ref: 'item:4', stars: 5, comment: '測試回饋' }] } });
    await api(`/api/orders/${orderId}/rate`, { cookie: customer, body: { ratings: [{ ref: 'item:4', stars: 4, comment: '' }] }, status: 400 });
    const stats = (await api('/api/boss/stats?range=all', { cookie: boss })).value;
    assert.equal(stats.revenue, 75);
    assert.equal(stats.orders, 1);
    const history = (await api('/api/boss/history?from=2030-01-01&to=2030-01-01', { cookie: boss })).value;
    assert.equal(history.summary.revenue, 75);
    assert.equal(history.orders[0].remark, '飲料分開裝');
    assert.equal(history.daily[0].orders, 1);
    await api('/api/boss/history?from=2030-01-01&to=2030-01-01', { cookie: customer, status: 403 });
  });
  await t.test('concurrent redemptions cannot overspend and cancellation refunds', async () => {
    const responses = await Promise.all([1, 2].map(() => fetch(app.url + '/api/orders', {
      method: 'POST', headers: { Cookie: customer, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...orderBody, usePoints: 2 }),
    })));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 400]);
    const index = responses.findIndex(r => r.status === 201);
    secondOrderId = (await responses[index].json()).id;
    assert.equal((await api('/api/me', { cookie: customer })).value.points, 0);
    await api(`/api/orders/${secondOrderId}/cancel`, { cookie: customer, body: {} });
    assert.equal((await api('/api/me', { cookie: customer })).value.points, 2);
  });
  await t.test('database constraints roll back the complete transaction', async () => {
    await assert.rejects(storage.transaction(async client => {
      const previous = await storage.load(client);
      const invalid = structuredClone(previous);
      invalid.users.find(u => u.username === 'student').points = 100;
      invalid.orders[0].total = -1;
      await storage.save(client, invalid, previous);
    }), error => error.code === '23514');
    assert.equal((await api('/api/me', { cookie: customer })).value.points, 2);
  });
  await t.test('restart preserves sessions, orders, settings and passwords', async () => {
    await stop(app);
    app = await start();
    assert.equal((await api('/api/me', { cookie: customer })).value.name, '測試同學');
    assert.equal((await api('/api/me', { cookie: customer })).value.points, 2);
    const orders = (await api('/api/my/orders', { cookie: customer })).value;
    assert.equal(orders.length, 2);
    assert.equal(orders.find(order => order.id === orderId).remark, '飲料分開裝');
    assert.equal((await api('/api/boss/settings', { cookie: boss })).value.open, '00:00');
    await api('/api/login', { body: { username: 'student', password: 'student1234' } });
  });
  await t.test('imports legacy JSON once, preserves hashes and upgrades old options', async () => {
    const state = await storage.transaction(client => storage.load(client));
    state.menu[0].options = ['原味', '加辣'];
    delete state.menu[0].groups;
    state.seq.user = 0;
    const filename = path.join(scratch, 'data.json');
    const source = JSON.stringify(state);
    fs.writeFileSync(filename, source);
    const importedApp = await start(importedSchema, filename);
    assert.equal(fs.readFileSync(filename, 'utf8'), source);
    const menu = (await api('/api/menu', { instance: importedApp })).value;
    assert.equal(menu.menu[0].groups[0].choices[1].label, '加辣');
    await api('/api/login', { instance: importedApp, body: { username: 'student', password: 'student1234' } });
    await stop(importedApp);
    fs.writeFileSync(filename, '{}');
    const restarted = await start(importedSchema, filename);
    assert.equal((await api('/api/me', { instance: restarted, cookie: customer })).value.points, 2);
    await stop(restarted);
  });
  await t.test('upgrades an existing v1 database without resetting orders or accounts', async () => {
    // 僅在本次測試專屬 schema 模擬舊版結構。
    await imported.pool.query(`ALTER TABLE "${importedSchema}".menu DROP COLUMN sold_out_date`);
    await imported.pool.query(`ALTER TABLE "${importedSchema}".orders DROP COLUMN remark`);
    await imported.pool.query(`UPDATE "${importedSchema}".system_state SET value='1'::jsonb WHERE key='schema_version'`);
    const upgraded = await start(importedSchema);
    assert.equal((await api('/api/me', { instance: upgraded, cookie: customer })).value.points, 2);
    const orders = (await api('/api/my/orders', { instance: upgraded, cookie: customer })).value;
    assert.equal(orders.length, 2);
    assert.equal(orders[0].remark, '');
    const version = await imported.pool.query(`SELECT value FROM "${importedSchema}".system_state WHERE key='schema_version'`);
    assert.equal(version.rows[0].value, 3);
    await stop(upgraded);
  });
  await t.test('production replaces public admin password, disables demo login and sends secure cookies', async () => {
    await imported.transaction(async client => {
      const previous = await imported.load(client);
      const next = structuredClone(previous);
      const user = next.users.find(user => user.role === 'boss');
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = crypto.scryptSync('boss1234', user.salt, 32).toString('hex');
      await imported.save(client, next, previous);
    });
    const production = await start(importedSchema, path.join(scratch, 'absent.json'), {
      NODE_ENV: 'production', BOSS_PASSWORD: 'ProductionTestPassword1234', RENDER_EXTERNAL_URL: 'https://test.example',
    });
    await api('/api/login', { instance: production, body: { username: 'boss', password: 'boss1234' }, status: 401 });
    await api('/api/login', { instance: production, body: { username: 'demo', password: 'demo1234' }, status: 401 });
    const response = await fetch(production.url + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'ProductionTestPassword1234' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie'), /; Secure/);
    await stop(production);
  });
});
