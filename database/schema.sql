-- 由程式在獨立 schema 建表，不修改 public 或其他專案。
CREATE TABLE IF NOT EXISTS system_state (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  open_time TEXT NOT NULL CHECK (open_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  close_time TEXT NOT NULL CHECK (close_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  accepting BOOLEAN NOT NULL, point_rate INTEGER NOT NULL CHECK (point_rate BETWEEN 1 AND 1000),
  CHECK (open_time < close_time)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY CHECK (id > 0), username TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('boss','customer')),
  points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0), provider TEXT NOT NULL,
  provider_id TEXT, salt TEXT, password_hash TEXT, created_at TIMESTAMPTZ NOT NULL,
  CHECK (provider <> 'local' OR (salt IS NOT NULL AND password_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(lower(username));
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_unique ON users(provider, provider_id) WHERE provider_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS menu (
  id INTEGER PRIMARY KEY CHECK (id > 0), name TEXT NOT NULL, price INTEGER NOT NULL CHECK (price > 0),
  category TEXT NOT NULL, description TEXT NOT NULL, photo TEXT NOT NULL DEFAULT '', available BOOLEAN NOT NULL,
  option_groups JSONB NOT NULL CHECK (jsonb_typeof(option_groups) = 'array')
);
CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY CHECK (id > 0), name TEXT NOT NULL, price INTEGER NOT NULL CHECK (price > 0),
  description TEXT NOT NULL, photo TEXT NOT NULL DEFAULT '', available BOOLEAN NOT NULL,
  items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array')
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY CHECK (id > 0), user_id INTEGER NOT NULL REFERENCES users(id), customer_name TEXT NOT NULL,
  items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  subtotal INTEGER NOT NULL CHECK (subtotal >= 0), points_used INTEGER NOT NULL CHECK (points_used >= 0),
  total INTEGER NOT NULL CHECK (total >= 0), points_earned INTEGER NOT NULL CHECK (points_earned >= 0),
  pickup_time TEXT NOT NULL CHECK (pickup_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  order_date TEXT NOT NULL CHECK (order_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  status TEXT NOT NULL CHECK (status IN ('待接單','已接單','製作完成','已取餐','已拒絕','已取消')),
  number TEXT, reject_reason TEXT NOT NULL DEFAULT '', cancel_reason TEXT, rated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL, history JSONB NOT NULL CHECK (jsonb_typeof(history) = 'array'),
  CHECK (total = subtotal - points_used), UNIQUE (order_date, number)
);
CREATE INDEX IF NOT EXISTS orders_user_date ON orders(user_id, order_date);
CREATE INDEX IF NOT EXISTS orders_date_status ON orders(order_date, status);
CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY CHECK (id > 0), order_id INTEGER NOT NULL REFERENCES orders(id), user_id INTEGER NOT NULL REFERENCES users(id),
  ref TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 0 AND 5), comment TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL, UNIQUE (order_id, ref)
);
CREATE INDEX IF NOT EXISTS ratings_ref ON ratings(ref);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);

-- v2：相容組長 Iteration 3 的今日售完與訂單備註；既有 v1 資料不重建。
ALTER TABLE menu ADD COLUMN IF NOT EXISTS sold_out_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS remark TEXT NOT NULL DEFAULT '';

-- v3：照片存在雲端資料庫，不依賴部署主機的暫存磁碟。
CREATE TABLE IF NOT EXISTS photos (
  name TEXT PRIMARY KEY CHECK (name ~ '^[a-f0-9]{24}\.(png|jpg|webp|gif)$'),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp','image/gif')),
  data BYTEA NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 2097152),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
