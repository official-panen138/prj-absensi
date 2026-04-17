import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDbPath() {
  if (process.env.DB_PATH) return process.env.DB_PATH;
  for (const dir of ['/data', '/app/data', '/var/data']) {
    try { if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return path.join(dir, 'data.db'); } catch {}
  }
  return path.join(__dirname, 'data.db');
}

const dbPath = resolveDbPath();
const isPersistent = dbPath.startsWith('/data') || dbPath.startsWith('/app/data') || dbPath.startsWith('/var/data') || !!process.env.DB_PATH;

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
console.log(`[db] path: ${dbPath}`);
console.log(`[db] persistent: ${isPersistent ? 'YES' : 'NO (⚠ ephemeral — data will be lost on next deploy)'}`);

function hasColumn(table, col) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some((c) => c.name === col);
  } catch { return false; }
}

function tableExists(name) {
  const r = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!r;
}

function migrateV1_InitialSchema() {
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
      month TEXT,
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

function migrateV2_MultiTenant() {
  // Tenants table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Ensure default tenant "PanenGroup" exists
  let defaultTenant = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('panengroup');
  if (!defaultTenant) {
    const r = db.prepare('INSERT INTO tenants(slug,name) VALUES(?,?)').run('panengroup', 'PanenGroup');
    defaultTenant = { id: r.lastInsertRowid };
    console.log(`[db] created default tenant PanenGroup (id=${defaultTenant.id})`);
  }
  const defaultTenantId = defaultTenant.id;

  // Add tenant_id to entity tables (null = belongs to no tenant / super_admin scope)
  const entityTables = [
    'users', 'staff', 'schedules', 'schedule_daily', 'attendance',
    'break_log', 'swap_requests', 'workstations',
  ];
  for (const t of entityTables) {
    if (!hasColumn(t, 'tenant_id')) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN tenant_id INTEGER`);
      console.log(`[db] added tenant_id to ${t}`);
    }
  }

  // Backfill: all existing rows (except super_admin users) get assigned to PanenGroup
  for (const t of ['staff', 'schedules', 'schedule_daily', 'attendance', 'break_log', 'swap_requests', 'workstations']) {
    const updated = db.prepare(`UPDATE ${t} SET tenant_id = ? WHERE tenant_id IS NULL`).run(defaultTenantId);
    if (updated.changes > 0) console.log(`[db] backfilled ${updated.changes} rows in ${t}`);
  }
  // Users: only assign tenant_id to non-super_admin roles
  const usersUpdated = db.prepare(`UPDATE users SET tenant_id = ? WHERE tenant_id IS NULL AND role != 'super_admin'`).run(defaultTenantId);
  if (usersUpdated.changes > 0) console.log(`[db] backfilled ${usersUpdated.changes} users`);

  // --- settings: recreate with (tenant_id, key) PK if not already done ---
  const settingsHasTenant = hasColumn('settings', 'tenant_id');
  if (!settingsHasTenant && tableExists('settings')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings_new (
        tenant_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (tenant_id, key)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO settings_new(tenant_id,key,value) SELECT ?, key, value FROM settings').run(defaultTenantId);
    db.exec('DROP TABLE settings');
    db.exec('ALTER TABLE settings_new RENAME TO settings');
    console.log('[db] settings migrated to tenant-scoped');
  } else if (!tableExists('settings')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        tenant_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY (tenant_id, key)
      );
    `);
  }

  // --- break_settings: recreate with (tenant_id, type) PK ---
  const bsHasTenant = hasColumn('break_settings', 'tenant_id');
  if (!bsHasTenant && tableExists('break_settings')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS break_settings_new (
        tenant_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        daily_quota_minutes INTEGER,
        PRIMARY KEY (tenant_id, type)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO break_settings_new(tenant_id,type,daily_quota_minutes) SELECT ?, type, daily_quota_minutes FROM break_settings').run(defaultTenantId);
    db.exec('DROP TABLE break_settings');
    db.exec('ALTER TABLE break_settings_new RENAME TO break_settings');
    console.log('[db] break_settings migrated to tenant-scoped');
  } else if (!tableExists('break_settings')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS break_settings (
        tenant_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        daily_quota_minutes INTEGER,
        PRIMARY KEY (tenant_id, type)
      );
    `);
  }

  // --- shifts: recreate with (tenant_id, name) PK ---
  const shHasTenant = hasColumn('shifts', 'tenant_id');
  if (!shHasTenant && tableExists('shifts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shifts_new (
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        PRIMARY KEY (tenant_id, name)
      );
    `);
    db.prepare('INSERT OR IGNORE INTO shifts_new(tenant_id,name,start_time,end_time) SELECT ?, name, start_time, end_time FROM shifts').run(defaultTenantId);
    db.exec('DROP TABLE shifts');
    db.exec('ALTER TABLE shifts_new RENAME TO shifts');
    console.log('[db] shifts migrated to tenant-scoped');
  } else if (!tableExists('shifts')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS shifts (
        tenant_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        start_time TEXT,
        end_time TEXT,
        PRIMARY KEY (tenant_id, name)
      );
    `);
  }

  // Indexes for tenant_id lookups
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_staff_tenant ON staff(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sched_tenant ON schedules(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_att_tenant ON attendance(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_bl_tenant ON break_log(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_sw_tenant ON swap_requests(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_ws_tenant ON workstations(tenant_id);
  `);
}

export function migrate() {
  migrateV1_InitialSchema();
  migrateV2_MultiTenant();
}

// Look up default tenant (for backward-compat single-tenant fallback)
export function getDefaultTenantId() {
  const t = db.prepare('SELECT id FROM tenants WHERE slug = ?').get('panengroup');
  return t?.id || null;
}

// Tenant-scoped helpers (new — use this for per-tenant operations)
export function getTenantSetting(tenantId, key, fallback = null) {
  if (!tenantId) return fallback;
  const row = db.prepare('SELECT value FROM settings WHERE tenant_id = ? AND key = ?').get(tenantId, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

export function setTenantSetting(tenantId, key, value) {
  if (!tenantId) return;
  const v = JSON.stringify(value);
  db.prepare('INSERT INTO settings(tenant_id,key,value) VALUES(?,?,?) ON CONFLICT(tenant_id,key) DO UPDATE SET value=excluded.value').run(tenantId, key, v);
}

// Backward-compat: operate on default tenant
export function getSetting(key, fallback = null) {
  return getTenantSetting(getDefaultTenantId(), key, fallback);
}

export function setSetting(key, value) {
  return setTenantSetting(getDefaultTenantId(), key, value);
}

migrate();
