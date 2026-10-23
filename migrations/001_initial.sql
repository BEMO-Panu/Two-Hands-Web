CREATE TABLE users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password_hash TEXT, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 email_verified INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0, mfa_last_step INTEGER NOT NULL DEFAULT -1
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, auth_at INTEGER
);
CREATE INDEX session_user ON sessions(user_id);
CREATE TABLE email_tokens (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('verify','reset')), expires_at INTEGER NOT NULL
);
CREATE TABLE shops (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), name TEXT NOT NULL,
 location TEXT NOT NULL, bio TEXT NOT NULL DEFAULT '', verification_details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'none'
 CHECK(status IN ('none','pending','verified','rejected')), reviewed_by TEXT REFERENCES users(id),
 review_note TEXT, submitted_at INTEGER, reviewed_at INTEGER, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE products (
 id TEXT PRIMARY KEY, shop_id TEXT NOT NULL REFERENCES shops(id), title TEXT NOT NULL,
 description TEXT NOT NULL, category TEXT NOT NULL, condition TEXT NOT NULL, location TEXT NOT NULL,
 image TEXT NOT NULL, price INTEGER NOT NULL CHECK(price BETWEEN 1 AND 10000000),
 mode TEXT NOT NULL CHECK(mode IN ('fixed','auction')), bid_step INTEGER NOT NULL DEFAULT 50 CHECK(bid_step>0),
 ends_at INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','reserved','sold','ended')),
 created_at INTEGER NOT NULL, is_demo INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE bids (
 id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id), user_id TEXT NOT NULL REFERENCES users(id),
 amount INTEGER NOT NULL CHECK(amount>0), created_at INTEGER NOT NULL,
 request_key TEXT NOT NULL, UNIQUE(user_id,request_key)
);
CREATE INDEX product_bids ON bids(product_id,created_at);
CREATE TABLE favorites (user_id TEXT REFERENCES users(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE CASCADE,PRIMARY KEY(user_id,product_id));
CREATE TABLE cart (user_id TEXT REFERENCES users(id) ON DELETE CASCADE,product_id TEXT REFERENCES products(id) ON DELETE CASCADE,PRIMARY KEY(user_id,product_id));
CREATE TABLE orders (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), total INTEGER NOT NULL,
 delivery TEXT NOT NULL CHECK(delivery IN ('pickup','shipping')), address TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'awaiting_payment', created_at INTEGER NOT NULL,
 idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, UNIQUE(user_id,idempotency_key)
);
CREATE TABLE order_items (
 order_id TEXT NOT NULL REFERENCES orders(id),product_id TEXT NOT NULL REFERENCES products(id),
 shop_id TEXT NOT NULL REFERENCES shops(id),title TEXT NOT NULL,price INTEGER NOT NULL,
 PRIMARY KEY(order_id,product_id)
);
CREATE TABLE uploads (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),media_type TEXT NOT NULL,filename TEXT NOT NULL,size INTEGER NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE reports (id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),product_id TEXT REFERENCES products(id),reason TEXT NOT NULL,details TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL);
CREATE TABLE security_events (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT REFERENCES users(id),action TEXT NOT NULL,subject TEXT,created_at INTEGER NOT NULL);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE mfa_recovery (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,PRIMARY KEY(user_id,code_hash));
