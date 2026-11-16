'use strict';
// 只在測試子程序改用 Neon 池化網址，不修改 .env，不輸出密碼。
const { spawn } = require('node:child_process');
const path = require('node:path');
const { databaseConfig } = require('../config');
function main() {
  const url = new URL(databaseConfig().connectionString);
  if (!url.hostname.endsWith('.neon.tech') || !url.hostname.startsWith('ep-')) {
    throw new Error('此測試僅支援 Neon endpoint');
  }
  const labels = url.hostname.split('.');
  if (!labels[0].endsWith('-pooler')) labels[0] += '-pooler';
  url.hostname = labels.join('.');
  console.log('使用 Neon 池化連線執行隔離整合測試；不修改正式設定。');
  const child = spawn(process.execPath, ['--test', path.join(__dirname, 'database.test.js')], {
    env: { ...process.env, DATABASE_URL: url.toString() }, stdio: 'inherit',
  });
  child.on('error', () => { console.error('無法啟動測試程序'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}
try { main(); } catch { console.error('池化測試設定不正確，請檢查 Neon 連線設定。'); process.exitCode = 1; }
