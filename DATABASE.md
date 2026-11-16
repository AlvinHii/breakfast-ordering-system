# PostgreSQL 實作說明

> v3 公開部署更新（2026/11/16）：照片已改存 PostgreSQL `photos` 表，不依賴主機暫存檔案；保留單張 2 MB 上限並自動匯入本機舊照片。共 9 張資料表。正式環境停用預設 demo 登入，替換老闆公開預設密碼，並設定 HTTPS Secure cookie。部署以 [DEPLOYMENT.md](DEPLOYMENT.md) 為準；下方 v1/v2 文字保留先前整合紀錄。

## 本次變更

保留原顧客與老闆前端、API 網址及訂單流程。以 PostgreSQL 取代 JSON 檔案及尚未交付的 SQLite 初稿。`config.js` 讀取專案資料夾 `.env`，`storage.js` 處理 PostgreSQL 連線、交易及資料對應，`database/schema.sql` 定義版本 1 的資料表。

預設使用獨立的 `breakfast_shop` schema，不會修改 `public` 或其他專案。可透過 `DB_SCHEMA` 指定其他 schema，僅接受小寫英文字母開頭及英數底線，最長 63 字元。

本分支以組長最新 main 為基底，保留 Iteration 3 的歷史報表、今日售完、再點一次、備註與前端樣式。資料庫版本為 v2：在 v1 表上追加 `menu.sold_out_date` 及 `orders.remark`，不刪除原表或重設帳號、訂單、點數。舊 JSON 沒有備註時預設空字串；售完日期以台北日期判斷，隔日自動恢復。

## 資料表

| 資料表 | 儲存內容／限制 |
|---|---|
| users | 帳號、角色、點數、第三方身分及加鹽密碼雜湊；帳號不分大小寫唯一，點數不可負數 |
| menu | 餐點名稱、價格、分類、說明、圖片路徑、上下架及 JSONB 選項群組 |
| combos | 套餐名稱、價格、圖片路徑、上下架與 JSONB 組合內容 |
| orders | 顧客外鍵、各金額欄位、狀態、預約時間、每日序號及 JSONB 餐點快照／歷程 |
| ratings | 訂單與顧客外鍵、餐點參照、0–5 星及留言；同訂單同品項不可重複 |
| sessions | 登入 token、顧客外鍵與到期毫秒，重啟後保留登入狀態 |
| settings | 營業起訖時間、接單開關、點數門檻，單筆設定 |
| system_state | schema 版本、初始化標記及舊程式各類 ID 計數器 |

`orders.user_id → users.id`；`ratings.order_id → orders.id`；`ratings.user_id`、`sessions.user_id → users.id`。

餐點選項、套餐內容和訂單品項保留 JSONB，避免改變原本的客製與歷史快照資料格式；不是每個選項都拆成關聯表。歷史訂單品項不以現行菜單為外鍵，因此刪除菜單不會抹掉過去訂單。

## 交易與一致性

每次 API 操作先取得 PostgreSQL 交易層級 advisory lock，再讀取資料快照。原本路由的 `save()` 改成標記變更，在整次操作成功後透過參數化 SQL 更新變動資料列並提交。應用內的工作佇列避免非同步操作交錯，共用的資料庫鎖避免同時折抵相同點數或分配相同取餐序號。

發生錯誤會回滾完整交易與丟棄記憶體變更，HTTP 成功回應及事件通知在提交後發送。斷線時回傳錯誤，不會默默改回 JSON 或示範資料。對外不顯示連線字串及資料庫錯誤 DETAIL。雲端連線使用 TLS 並驗證伺服器憑證。

這是保留既有程式結構的資料庫版本：讀取仍為整體快照，適合目前小型專案；大量資料應改為各 API 的 SQL 分頁及彙總。SSE 訂閱者仍在單一服務記憶體內，部署先使用一個服務實例。

## 舊資料匯入

1. 停止舊服務，備份 `data.json` 與 `uploads/`。
2. 將 `data.json` 放在本專案 `server.js` 旁。也可指定 `LEGACY_DATA_FILE`。
3. 在 `.env` 設定 `DATABASE_URL`，執行 `npm run db:migrate`。
4. 空資料庫才會讀取舊 JSON；保留帳號 ID、密碼雜湊、訂單、點數、評價及 session。舊 `options` 轉為選項群組，ID 計數器提升到不低於現存最大 ID。
5. 任一資料違反約束時，整批匯入回滾；修正舊檔後可重試。原 JSON 不修改、不刪除。
6. 已初始化時忽略舊檔，以資料庫為準。重新部署不會清空資料。

目前目錄若沒有舊資料，會加入原始示範資料；其他資料夾的舊 JSON 不會自動搜尋或上傳。照片仍需另外帶到持久的 `UPLOAD_DIR`，本次不是照片雲端化。

## 設定及操作

```powershell
cd 你下載此儲存庫的資料夾
npm ci
npm run db:check
npm run db:migrate
npm start
```

正式環境將同樣設定加入主機環境變數，不上傳 `.env`。`DATABASE_URL` 是後端機密，不能放進 `public/` 或瀏覽器程式。首次正式初始化請設定 `BOSS_PASSWORD`；原本的 demo 帳號是展示用途，公開上線前需處理。

Neon 的表格介面或 SQL Editor 可查看 `breakfast_shop` schema：

```sql
SELECT id, name, price, available FROM breakfast_shop.menu ORDER BY id;
SELECT id, customer_name, status, total, number FROM breakfast_shop.orders ORDER BY id DESC;
SELECT id, username, role, points FROM breakfast_shop.users ORDER BY id;
```

不要查詢或截圖分享 password_hash、salt、sessions token 等敏感欄位。備份使用 Neon 提供的備份／還原能力或 PostgreSQL `pg_dump`；正式還原應在獨立資料庫驗證後再切換，不可直接用測試清除指令操作正式 schema。

## 驗證

`npm test` 連到實際 PostgreSQL，在 `test_breakfast_隨機字串` 建立隔離測試區。測試內容含：註冊登入、權限、菜單套餐與設定、下單、提交後 SSE、接單取號、製作與取餐、點數、評價、營收、同時折抵、取消退款、資料庫約束回滾、服務重啟及舊 JSON 一次性匯入。

另外驗證今日售完重啟後保留、停售單點及相關套餐、訂單備註持久化、歷史營收報表，以及既有 v1 schema 升級 v2 後資料不重設。再點一次仍使用組長原有的前端購物車邏輯，送單時由相同的 API 重新驗價、檢查售完與寫入資料庫。

測試結束只刪除本次產生的測試 schema。若強制中斷測試導致未清理，可先確認其名稱與用途，再由資料庫管理員清除；不會影響正式 `breakfast_shop`。

`npm run test:pooled` 將 Neon endpoint 換成對應的 `-pooler` 網址，只在子程序的環境變數內套用，再執行同一套隔離整合測試；不改寫 `.env`，也不輸出連線資訊。這可以檢查交易鎖、交易內 schema 設定及建表流程在 Neon 的交易池化模式下是否相容。
