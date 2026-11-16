# Google／GitHub 登入設定

現有程式支援兩個提供者；取得各平台的 OAuth Client ID 與 Secret，設定 Render 後重新部署才能開通。不可把 Secret 提交 GitHub。

網站首頁：https://beining-breakfast.onrender.com/

## GitHub

在 https://github.com/settings/applications/new 建立 OAuth App：

- Application name：北寧早餐店
- Homepage URL：https://beining-breakfast.onrender.com/
- Redirect URI：https://beining-breakfast.onrender.com/auth/github/callback
- 不啟用 wildcard matching 或 Device Flow。
- Client ID、Client Secret 分別填入 Render 的 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。

## Google

在 Google Cloud 的 Google Auth Platform 設定品牌資訊、受眾及 OAuth Client，類型選 Web application。

- Authorized redirect URI：https://beining-breakfast.onrender.com/auth/google/callback
- Client ID、Client Secret 分別填入 Render 的 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。
- 測試模式僅允許指定測試使用者；若要全班使用，須依 Google 控制台要求設定發布狀態。
- 此程式要求 openid、profile，使用識別碼與顯示名稱，不要求信箱或存取儲存庫。

重新部署後，`/api/auth/providers` 對應提供者的 enabled 應為 true。再於網站實際授權、返回、重新整理、登出與再次登入確認同一會員資料。enabled 只代表已填金鑰，不能代替完整登入測試。

## 擴充示範菜單

`node database/expand-menu.js` 預覽新增項目；`node database/expand-menu.js --apply` 寫入目前 DATABASE_URL 對應資料庫。保留既有同名餐點，重複執行不重複新增。此操作只新增菜單與套餐，不更動帳號或訂單，不會在每次網站啟動自動執行。
