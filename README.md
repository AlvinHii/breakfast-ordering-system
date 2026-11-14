# 北寧路早餐店系統（完整版，不含資料庫）

只用 Node.js 內建模組，**不需要 `npm install`**。資料存在 `data.json`，上傳的照片存在 `uploads/`。

## 執行（Windows PowerShell）

```powershell
cd 你放這個資料夾的位置
node server.js
```

| 頁面 | 網址 | 示範帳號 |
|---|---|---|
| 顧客點餐 | http://localhost:3000/ | demo / demo1234（也可自己註冊） |
| 老闆後台 | http://localhost:3000/boss | boss / boss1234 |

- 第一次啟動時，系統會自動建立 `data.json`，並放入示範菜單與帳號。想清空重來，就停掉伺服器、刪掉 `data.json` 再啟動。
- 換埠號：`$env:PORT="3001"; node server.js`
- 改老闆密碼（第一次啟動前設定）：`$env:BOSS_PASSWORD="你的密碼"; node server.js`
- 為了方便測試，預設營業時間是 06:00–21:00，可以在後台「設定」改成實際時間。

## 需求對照

| 需求 | 實作方式 | 位置 |
|---|---|---|
| 基本 1　老闆與顧客兩種角色 | 帳號密碼登入（scrypt 雜湊）。老闆和顧客的 API 權限分開 | 登入對話框、/boss |
| 基本 2　老闆上架餐點 | 名稱、單價、分類、說明、照片、客製選項，可上架或下架 | 後台 → 餐點 |
| 基本 3　顧客瀏覽完整菜單 | 依分類顯示，含照片、評分、本月熱門標籤 | 顧客頁 |
| 基本 4　規定時段內點餐 | 只能在營業時間內下單，老闆也可以暫停接單 | 後台 → 設定 |
| 基本 5　設定預定取餐時間 | 至少下單後 15 分鐘，且不能晚於打烊時間。前端和伺服器都會檢查 | 購物車 |
| 基本 6　老闆即時收單、接受或拒絕 | 新訂單即時推播，並有提示音、閃爍。拒絕時要填原因 | 後台 → 訂單 |
| 基本 7　接受後產生序號、加入製作清單 | 接單時才給號碼（A01、A02…，每日重編）。製作清單依取餐時間排序 | 後台 → 訂單 |
| 基本 8　顧客查看訂單狀態 | 待接單 → 已接單 → 製作完成 → 已取餐，附進度條 | 顧客頁 → 我的訂單 |
| 基本 9　「已接單」「餐點完成」通知 | 頁面提示＋提示音。分頁在背景時跳出瀏覽器通知 | 顧客頁 |
| 進階 1　套餐 | 名稱、價格、餐點組合、照片、說明 | 後台 → 套餐 |
| 進階 2　即時推播 | Server-Sent Events（`/api/events`），不再輪詢 | 全站 |
| 進階 3　評價與評分 | 取餐後可以對每項餐點打 0–5 星並留言。餐點資訊頁顯示平均、星等分布和評論 | 我的訂單 → 評價 |
| 進階 4　銷售統計 | 今日、本月、全部：營業額、客單價、各餐點銷售排行、評價星等分布 | 後台 → 銷售統計 |
| 進階 5　第三方登入 | GitHub、Google OAuth 2.0（需要設定，見下方） | 登入對話框 |
| 故事：會員點數（陳科宇） | 每 30 元 1 點（後台可改），取餐後入帳。點數可折抵，1 點 = 1 元。取消訂單會退回用掉的點數，並扣回這筆訂單得到的點數 | 購物車、我的訂單 |

**和使用者故事不同的地方**：江宗衡的故事寫「送出訂單後產生取餐號碼」，題目基本需求 #7 則寫「訂單被接受時產生序號」。本系統依照題目需求 #7：送出後先顯示「訂購成功、等待店家接單」，接單後才產生 A01，並通知顧客。這一點建議在 Miro 上同步修改。

## 第三方登入設定（選用）

沒有設定時按鈕是灰的，其他功能照常使用。

1. GitHub：Settings → Developer settings → OAuth Apps → New，Callback URL 填 `http://localhost:3000/auth/github/callback`
2. Google：Google Cloud Console → 憑證 → OAuth 用戶端 ID（網頁應用程式），重新導向 URI 填 `http://localhost:3000/auth/google/callback`
3. 啟動前設定環境變數：

```powershell
$env:GITHUB_CLIENT_ID="..."; $env:GITHUB_CLIENT_SECRET="..."
$env:GOOGLE_CLIENT_ID="..."; $env:GOOGLE_CLIENT_SECRET="..."
node server.js
```

需要 Node.js 18 以上。如果不是在 localhost，請另外設定 `$env:BASE_URL="https://你的網址"`。

## 安全措施

- 密碼用 scrypt 加鹽雜湊。登入用 HttpOnly、SameSite=Lax 的 cookie，有效 7 天。
- 寫入類請求只接受 JSON，加上 SameSite cookie 防止跨站偽造請求。
- 伺服器會重新檢查價格、選項、數量（1–20）、取餐時間和點數，不信任前端傳來的金額。
- 照片只接受 PNG、JPG、WEBP、GIF，上限 2 MB，檔名隨機產生，前端會先縮圖。
- 輸出到畫面的文字都會做 HTML 跳脫。

## API

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| POST | /api/register, /api/login, /api/logout | — | 帳號 |
| GET | /api/me | — | 目前登入者 |
| GET | /api/menu | — | 菜單、套餐、營業狀態、評分摘要、本月熱門 |
| GET | /api/ratings/:ref | — | 某餐點的評論（ref 例如 `item:4`） |
| POST | /api/orders | 顧客 | 下單 `{items:[{type,ref,qty,note}], pickupTime, usePoints}` |
| GET | /api/my/orders | 顧客 | 我的訂單 |
| POST | /api/orders/:id/cancel | 顧客 | 取消（限待接單） |
| POST | /api/orders/:id/rate | 顧客 | 評價 `{ratings:[{ref,stars,comment}]}` |
| GET | /api/events | 登入者 | 即時推播（SSE） |
| GET | /api/boss/orders | 老闆 | 今日與未結束訂單 |
| POST | /api/boss/orders/:id/accept, /reject, /status, /cancel | 老闆 | 接單、拒絕、製作完成或已取餐、取消 |
| GET/POST/PUT/DELETE | /api/boss/menu, /api/boss/combos | 老闆 | 餐點與套餐管理 |
| POST | /api/boss/upload | 老闆 | 上傳照片 |
| GET/PUT | /api/boss/settings | 老闆 | 營業時間、接單開關、點數門檻 |
| GET | /api/boss/stats?range=today\|month\|all | 老闆 | 銷售統計 |

## 尚未做（依指示）

正式資料庫：`data.json` 適合展示，不適合多台伺服器或大量資料。
