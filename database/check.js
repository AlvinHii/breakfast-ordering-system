'use strict';
const { databaseConfig, databaseError } = require('../config');
const { Storage } = require('../storage');
async function main() {
  const storage = new Storage(databaseConfig());
  try {
    await storage.pool.query('SELECT 1');
    console.log('PostgreSQL 連線成功（連線資訊已隱藏）。');
    const { rows } = await storage.pool.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1 ORDER BY table_name', [storage.schema]);
    console.log('專案資料表：' + (rows.map(r => r.table_name).join(', ') || '尚未建立，請執行 npm run db:migrate'));
  } finally { await storage.close(); }
}
main().catch(error => { console.error(databaseError(error)); process.exitCode = 1; });
