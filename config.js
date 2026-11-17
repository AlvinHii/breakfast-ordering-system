'use strict';
const path = require('node:path');
const fs = require('node:fs');
const filename = path.join(__dirname, '.env');
if (fs.existsSync(filename)) process.loadEnvFile(filename);
function databaseConfig() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('請先在 .env 設定 DATABASE_URL');
  return { connectionString, schema: process.env.DB_SCHEMA || 'breakfast_shop' };
}
// 不輸出原始錯誤內容：連線網址及 PostgreSQL DETAIL 可能含私人資料。
function databaseError(error) {
  const hints = {
    '28P01': '資料庫帳號或密碼不正確，請重新複製 Neon 連線字串。',
    '3D000': '指定的資料庫不存在。',
    '42501': '資料庫帳號沒有建立資料表或讀寫的權限。',
    ENOTFOUND: '無法解析資料庫網址，請檢查連線設定與網路。',
    ECONNREFUSED: '資料庫拒絕連線，請確認服務與網址。',
    ECONNRESET: '資料庫連線中斷，請檢查網路後重試。',
  };
  return hints[error.code] || `資料庫操作失敗（${/^[A-Z0-9_]+$/.test(error.code || '') ? error.code : '請檢查連線設定或資料格式'}）。`;
}
module.exports = { databaseConfig, databaseError };
