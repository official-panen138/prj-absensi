import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT DEFAULT 'indonesian',
      current_shift TEXT DEFAULT 'morning',
      department TEXT,
      phone TEXT,
      telegram_id TEXT,
      telegram_username TEXT,
      join_date TEXT,
      is_active INTEGER DEFAULT 1,
      is_approved INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT UNIQUE,
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS schedule_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      status TEXT DEFAULT 'work',
      shift TEXT DEFAULT 'morning',
      is_manual_override INTEGER DEFAULT 0,
      UNIQUE(staff_id, date),
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      shift TEXT,
      clock_in TEXT,
      clock_out TEXT,
      late_minutes INTEGER DEFAULT 0,
      ip_address TEXT,
      productive_ratio REAL DEFAULT 0,
      total_work_minutes INTEGER DEFAULT 0,
      total_break_minutes INTEGER DEFAULT 0,
      break_violations INTEGER DEFAULT 0,
      current_status TEXT DEFAULT 'working',
      break_start TEXT,
      break_type TEXT,
      break_limit INTEGER,
      UNIQUE(staff_id, date),
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS break_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendance_id INTEGER,
      staff_id INTEGER NOT NULL,
      type TEXT,
      start_time TEXT,
      end_time TEXT,
      duration_minutes INTEGER,
      limit_minutes INTEGER,
      is_overtime INTEGER DEFAULT 0,
      qr_token TEXT,
      qr_expires_at TEXT,
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS swap_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      requester_id INTEGER NOT NULL,
      target_date TEXT,
      current_shift TEXT,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      reject_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (requester_id) REFERENCES staff(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS break_settings (
      type TEXT PRIMARY KEY,
      daily_quota_minutes INTEGER
    );

    CREATE TABLE IF NOT EXISTS shifts (
      name TEXT PRIMARY KEY,
      start_time TEXT,
      end_time TEXT
    );

    CREATE TABLE IF NOT EXISTS workstations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      department TEXT,
      qr_token TEXT UNIQUE,
      is_active INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_sd_date ON schedule_daily(date);
    CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
    CREATE INDEX IF NOT EXISTS idx_bl_time ON break_log(start_time);
  `);
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setSetting(key, value) {
  const v = JSON.stringify(value);
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, v);
}

migrate();
