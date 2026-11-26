'use strict';
// SQLite（Node.js 標準の node:sqlite）によるデータ層。
// 外部DBサーバ不要で、data/app.db 1ファイルに全データを保存する。
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','staff')),
  password_hash TEXT NOT NULL,
  phone TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
DROP TABLE IF EXISTS sessions; -- 旧方式（署名付きCookieに移行済み）
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kana TEXT,
  address TEXT,
  phone TEXT,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 100,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tanks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  model TEXT,
  capacity TEXT,
  qr_version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  tank_id INTEGER REFERENCES tanks(id),
  assignee_id INTEGER NOT NULL REFERENCES users(id),
  scheduled_date TEXT NOT NULL,
  work_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled','arrived','scanned','completed','cancelled')),
  memo TEXT,
  arrived_at TEXT, arrived_lat REAL, arrived_lng REAL, arrived_acc REAL, arrived_distance REAL,
  scanned_at TEXT, scanned_lat REAL, scanned_lng REAL, scanned_acc REAL, scanned_distance REAL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_jobs_date ON jobs(scheduled_date, assignee_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  checklist_json TEXT NOT NULL,
  comment TEXT,
  lat REAL, lng REAL, acc REAL, distance REAL,
  submitted_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('report','alcohol')),
  ref_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  clock_in_at TEXT, clock_in_lat REAL, clock_in_lng REAL, clock_in_acc REAL, clock_in_alcohol_id INTEGER,
  clock_out_at TEXT, clock_out_lat REAL, clock_out_lng REAL, clock_out_acc REAL, clock_out_alcohol_id INTEGER,
  UNIQUE (user_id, work_date)
);
CREATE TABLE IF NOT EXISTS alcohol_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('clock_in','clock_out')),
  value_mgl REAL NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('pass','fail')),
  source TEXT NOT NULL CHECK (source IN ('device','manual')),
  device_id TEXT,
  device_reading_id INTEGER,
  lat REAL, lng REAL, acc REAL,
  checked_at TEXT NOT NULL
);
-- 検知器（クラウド連携型・据置型など）から API で送られてくる生の測定値
CREATE TABLE IF NOT EXISTS device_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  login_id TEXT NOT NULL,
  value_mgl REAL NOT NULL,
  measured_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_user ON locations(user_id, recorded_at);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL CHECK (level IN ('danger','warning','info')),
  type TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  job_id INTEGER,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
`);

const DEFAULT_SETTINGS = {
  alcohol_threshold_mgl: '0.00',   // この値を「超えたら」不合格（社内基準。法令の酒気帯びは0.15mg/L）
  allow_manual_alcohol: '1',       // 検知器API未導入時の手入力（写真必須）を許可するか
  device_reading_valid_minutes: '10', // 検知器の測定値を出勤に使える有効時間
  default_radius_m: '100',         // 顧客登録時の既定ジオフェンス半径
  max_accuracy_m: '100',           // これより精度が悪い位置情報は受け付けない
  min_stay_minutes: '3',           // 到着から報告送信までの最低滞在時間
  tracking_interval_sec: '60',     // 勤務中の位置送信間隔
  device_api_key: '',              // 検知器連携APIキー（初回起動時に自動生成）
};
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)').run(k, v);
}

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 単純なトランザクションヘルパ */
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, DATA_DIR, getSettings, setSetting, tx, DEFAULT_SETTINGS };
