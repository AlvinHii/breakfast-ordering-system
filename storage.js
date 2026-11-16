'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

// SQL 識別字只取自固定定義；使用者輸入一律使用 $1 等參數。
const tables = {
  users: [
    ['id', 'id'], ['username', 'username'], ['name', 'name'], ['role', 'role'],
    ['points', 'points'], ['provider', 'provider'], ['provider_id', 'providerId', 'optional'],
    ['salt', 'salt', 'optional'], ['password_hash', 'hash', 'optional'], ['created_at', 'createdAt'],
  ],
  menu: [
    ['id', 'id'], ['name', 'name'], ['price', 'price'], ['category', 'category'],
    ['description', 'desc'], ['photo', 'photo'], ['available', 'available'], ['option_groups', 'groups', 'json'],
    ['sold_out_date', 'soldOutDate', 'optional'],
  ],
  combos: [
    ['id', 'id'], ['name', 'name'], ['price', 'price'], ['description', 'desc'],
    ['photo', 'photo'], ['available', 'available'], ['items', 'items', 'json'],
  ],
  orders: [
    ['id', 'id'], ['user_id', 'userId'], ['customer_name', 'customerName'], ['items', 'items', 'json'],
    ['subtotal', 'subtotal'], ['points_used', 'pointsUsed'], ['total', 'total'], ['points_earned', 'pointsEarned'],
    ['pickup_time', 'pickupTime'], ['order_date', 'date'], ['status', 'status'], ['number', 'number'],
    ['reject_reason', 'rejectReason'], ['cancel_reason', 'cancelReason', 'optional'], ['rated', 'rated'],
    ['created_at', 'createdAt'], ['history', 'history', 'json'], ['remark', 'remark'],
  ],
  ratings: [
    ['id', 'id'], ['order_id', 'orderId'], ['user_id', 'userId'], ['ref', 'ref'],
    ['stars', 'stars'], ['comment', 'comment'], ['created_at', 'createdAt'],
  ],
  sessions: [['id', 'id'], ['user_id', 'userId'], ['expires_at', 'exp']],
};
function records(state, table) {
  if (!state) return [];
  return table === 'sessions' ? Object.entries(state.sessions).map(([id, value]) => ({ id, ...value })) : state[table];
}
class Storage {
  constructor({ connectionString, schema = 'breakfast_shop' }) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('DB_SCHEMA 格式不正確');
    let url;
    try { url = new URL(connectionString); }
    catch { throw new Error('DATABASE_URL 格式不正確，請填入完整 PostgreSQL 網址'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL 必須是 PostgreSQL 網址');
    // 雲端連線維持 TLS 憑證驗證。
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) url.searchParams.set('sslmode', 'verify-full');
    this.schema = schema;
    this.pool = new Pool({ connectionString: url.toString(), max: 3, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000 });
    this.pool.on('error', error => console.error('PostgreSQL 閒置連線中斷：', error.code || 'CONNECTION_ERROR'));
  }
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '15s'");
      await client.query("SET LOCAL statement_timeout = '30s'");
      // 同一專案的資料更新及取號依序處理，避免重複取號、超額折抵。
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`breakfast-shop:${this.schema}`]);
      await client.query('SELECT set_config($1, $2, true)', ['search_path', `"${this.schema}"`]);
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async initialize() {
    await this.transaction(async client => {
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      await client.query(fs.readFileSync(path.join(__dirname, 'database', 'schema.sql'), 'utf8'));
      const { rows } = await client.query("SELECT value FROM system_state WHERE key = 'schema_version'");
      if (rows.length && ![1, 2].includes(rows[0].value)) throw new Error('資料庫版本不相容');
      await client.query("INSERT INTO system_state(key, value) VALUES ('schema_version', '2') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value");
    });
  }
  async load(client) {
    // 一次往返讀取一致的交易快照，避免雲端連線逐表往返。
    const names = ['system_state', 'settings', ...Object.keys(tables)];
    const { rows: [snapshot] } = await client.query('SELECT ' + names.map(table =>
      `(SELECT COALESCE(jsonb_agg(row_data), '[]'::jsonb) FROM (SELECT * FROM ${table} ORDER BY ${table === 'system_state' ? 'key' : 'id'}) row_data) AS ${table}`
    ).join(', '));
    const meta = snapshot.system_state;
    const values = Object.fromEntries(meta.map(r => [r.key, r.value]));
    if (!values.initialized) return null;
    const settings = snapshot.settings;
    if (!settings.length) throw new Error('資料庫缺少營業設定');
    const s = settings[0];
    const state = { seq: values.seq, settings: { open: s.open_time, close: s.close_time, accepting: s.accepting, pointRate: s.point_rate } };
    for (const [table, fields] of Object.entries(tables)) {
      const rows = snapshot[table];
      const list = rows.map(row => Object.fromEntries(fields.flatMap(([column, key, type]) => {
        let value = row[column];
        if (type === 'optional' && value === null) return [];
        if (value instanceof Date) value = value.toISOString();
        if (table === 'sessions' && column === 'expires_at') value = Number(value);
        return [[key, value]];
      })));
      state[table] = table === 'sessions' ? Object.fromEntries(list.map(({ id, ...value }) => [id, value])) : list;
    }
    return state;
  }
  async save(client, state, previous = null) {
    // 只寫入變動資料列；複雜選項與歷史餐點快照使用 JSONB。
    for (const table of ['ratings', 'sessions', 'orders', 'combos', 'menu', 'users']) {
      const ids = new Set(records(state, table).map(row => row.id));
      for (const row of records(previous, table)) if (!ids.has(row.id)) await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
    }
    for (const [table, fields] of Object.entries(tables)) {
      const old = new Map(records(previous, table).map(row => [row.id, row]));
      const columns = fields.map(([column]) => column);
      const query = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})
        ON CONFLICT (id) DO UPDATE SET ${columns.slice(1).map(column => `${column} = EXCLUDED.${column}`).join(', ')}`;
      for (const row of records(state, table)) {
        if (JSON.stringify(old.get(row.id)) === JSON.stringify(row)) continue;
        await client.query(query, fields.map(([, key, type]) => type === 'json' ? JSON.stringify(row[key]) : (row[key] ?? (key === 'remark' ? '' : null))));
      }
    }
    if (!previous || JSON.stringify(previous.settings) !== JSON.stringify(state.settings)) {
      const s = state.settings;
      await client.query(`INSERT INTO settings(id, open_time, close_time, accepting, point_rate) VALUES (1,$1,$2,$3,$4)
        ON CONFLICT(id) DO UPDATE SET open_time=$1, close_time=$2, accepting=$3, point_rate=$4`, [s.open, s.close, s.accepting, s.pointRate]);
    }
    await client.query(`INSERT INTO system_state(key, value) VALUES ('seq',$1::jsonb), ('initialized','true')
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(state.seq)]);
  }
  async close() { await this.pool.end(); }
}
module.exports = { Storage };
