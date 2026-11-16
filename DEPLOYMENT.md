# 免費課程展示部署（Render + Neon）

網站使用 Render Free，資料庫沿用 Neon Free，不建立 Render Postgres、不加付費磁碟。

| 欄位 | 設定 |
|---|---|
| 類型 | Web Service（不是 Static Site） |
| Repository | https://github.com/AlvinHii/breakfast-ordering-system |
| Branch | feature/postgresql-integration |
| Runtime | Node |
| Region | Singapore |
| Plan | Free，確認畫面顯示 $0/month |
| Root Directory | 留白 |
| Build Command | npm ci |
| Start Command | npm start |
| Health Check Path | /healthz |

環境變數：`NODE_VERSION=24.12.0`、`NODE_ENV=production`、`DB_SCHEMA=breakfast_shop`。
`DATABASE_URL` 填 Neon 連線字串，可用池化網址；`BOSS_PASSWORD` 填至少 12 字元的獨立密碼。這兩項由使用者在 Render 直接填入，不提交 GitHub。

公開網址由 Render 的 `RENDER_EXTERNAL_URL` 自動取得，HTTPS cookie 設 Secure。自訂網域另設 `BASE_URL`。

自動建表升級至 v3。既有老闆若仍用公開預設 `boss1234`，正式啟動時改用 `BOSS_PASSWORD` 並清除該帳號舊 session；既有自訂密碼不會被每次部署覆寫。公開環境停用 demo/demo1234，顧客自行註冊。

照片保存於 PostgreSQL `photos` 表，每張上限 2 MB，網址仍為 `/uploads/隨機檔名`，重新部署後可讀取。啟動時匯入本機 uploads/ 的舊照片並保留原檔；若本機有尚未匯入的照片，先在本機啟動新版完成匯入。圖片占用 Neon 配額，適合少量課程資料，日後大量圖片再考慮物件儲存。

Render Free 閒置後休眠，下次訪問需等待喚醒，不保證全天候立即回應。報告前先開啟並測試。若超過免費限制，先查看控制台，不自動升級付費。

公開 Git URL 部署不一定支援自動更新。修改推送後，在 Render 使用 Manual Deploy；連接 Git Provider 則依平台設定部署。

執行 `npm run test:pooled` 驗證點餐、交易、照片重啟保存、版本升級及正式登入。部署後以公開網址確認 /healthz、菜單、註冊、下單與接單。
