import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { db, getSetting, setSetting, getDefaultTenantId, getTenantSetting, setTenantSetting } from './db.js';
import { startBot, reloadBot, getBotStatus, verifyInitData, notifyApproved, notifyLate, notifyOvertime, notifyIpViolation, pushBreakQRToMonitor, pushClockQRToMonitor, notifySwapRequest, pushSwapResultSnapshot, notifyLeaveRequest, pushLeaveResultSnapshot, notifyDailyOffSummary, notifyAdminOverride, notifyAutoCloseSummary, notifyBreakAutoEnded } from './bot.js';
import { applySwapApproval, applyLeaveApproval, calculateProductiveRatio } from './approvals.js';
import { liveBus, emitLiveUpdate } from './events.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
app.set('trust proxy', true); // Railway fronts via proxy; dibutuhkan agar req.ip return IP client asli
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

function ok(res, data, extra = {}) { return res.json({ success: true, data, ...extra }); }
function fail(res, status, message) { return res.status(status).json({ success: false, message }); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return fail(res, 401, 'Missing token');
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    req.user = payload;
    req.is_super_admin = payload.role === 'super_admin';
    // Super admin can override tenant context via X-Tenant-Id header
    if (req.is_super_admin) {
      const override = req.headers['x-tenant-id'];
      req.tenant_id = override ? parseInt(override) || null : null; // null = all tenants
    } else {
      req.tenant_id = payload.tenant_id || null;
    }
    next();
  } catch {
    return fail(res, 401, 'Invalid token');
  }
}

function requireSuperAdmin(req, res, next) {
  if (!req.is_super_admin) return fail(res, 403, 'Super admin only');
  next();
}

// Returns WHERE clause fragment (" AND <col> = ?") + param list for tenant scoping.
// If super_admin without tenant override → no filter.
// If tenant_id set → filter to that tenant.
function scopeTenant(req, col = 'tenant_id') {
  if (req.is_super_admin && !req.tenant_id) return { clause: '', params: [] };
  return { clause: ` AND ${col} = ?`, params: [req.tenant_id] };
}

// tenant_id to use for INSERTs (super_admin creating data in a specific tenant via header)
function writeTenantId(req) {
  if (req.tenant_id) return req.tenant_id;
  if (req.is_super_admin) return getDefaultTenantId(); // super_admin without header → default
  return req.user?.tenant_id || getDefaultTenantId();
}

// ============ AUTH ============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, 400, 'Username and password required');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return fail(res, 401, 'Invalid credentials');
  const token = jwt.sign({
    id: u.id, username: u.username, role: u.role, name: u.name, tenant_id: u.tenant_id || null,
  }, JWT_SECRET, { expiresIn: '7d' });
  let tenant = null;
  if (u.tenant_id) tenant = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?').get(u.tenant_id) || null;
  res.json({ token, user: { id: u.id, username: u.username, role: u.role, name: u.name, tenant_id: u.tenant_id || null, tenant } });
});

app.get('/api/auth/me', auth, (req, res) => {
  const u = db.prepare('SELECT id, username, role, name, tenant_id FROM users WHERE id = ?').get(req.user.id);
  if (!u) return fail(res, 404, 'User not found');
  let tenant = null;
  if (u.tenant_id) tenant = db.prepare('SELECT id, slug, name FROM tenants WHERE id = ?').get(u.tenant_id) || null;
  res.json({ user: u, tenant, is_super_admin: u.role === 'super_admin' });
});

// ============ TENANTS (super_admin) ============
app.get('/api/tenants', auth, (req, res) => {
  if (req.is_super_admin) {
    const rows = db.prepare('SELECT id, slug, name, created_at FROM tenants ORDER BY name').all();
    return ok(res, rows);
  }
  // Non-super-admin only sees their own tenant
  const t = req.user.tenant_id ? db.prepare('SELECT id, slug, name, created_at FROM tenants WHERE id = ?').get(req.user.tenant_id) : null;
  ok(res, t ? [t] : []);
});

app.post('/api/tenants', auth, requireSuperAdmin, (req, res) => {
  const { slug, name } = req.body || {};
  if (!slug || !name) return fail(res, 400, 'slug and name required');
  const s = String(slug).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!s) return fail(res, 400, 'Invalid slug');
  try {
    const r = db.prepare('INSERT INTO tenants(slug,name) VALUES(?,?)').run(s, name);
    ok(res, { id: r.lastInsertRowid, slug: s, name });
  } catch (e) {
    fail(res, 400, e.message);
  }
});

app.put('/api/tenants/:id', auth, requireSuperAdmin, (req, res) => {
  const id = +req.params.id;
  const { name } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  db.prepare('UPDATE tenants SET name = ? WHERE id = ?').run(name, id);
  ok(res, { id });
});

app.delete('/api/tenants/:id', auth, requireSuperAdmin, (req, res) => {
  const id = +req.params.id;
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM staff WHERE tenant_id = ?').get(id).c;
  if (cnt > 0) return fail(res, 400, `Cannot delete tenant with ${cnt} staff. Move/delete staff first.`);
  db.prepare('DELETE FROM tenants WHERE id = ?').run(id);
  ok(res, { id });
});

// ============ DEPARTMENTS ============
app.get('/api/departments', auth, (req, res) => {
  const sc = scopeTenant(req);
  const rows = db.prepare(`
    SELECT d.id, d.tenant_id, d.name, d.slug, d.head_telegram_id, d.head_username,
           d.assistant_telegram_id, d.assistant_username, d.monitor_group_chat_id, d.created_at,
           (SELECT COUNT(*) FROM staff s WHERE s.department_id = d.id AND s.is_active = 1) AS staff_count
    FROM departments d
    WHERE 1=1${sc.clause}
    ORDER BY d.name
  `).all(...sc.params);
  ok(res, rows);
});

app.post('/api/departments', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const { name, slug, head_telegram_id, head_username, assistant_telegram_id, assistant_username, monitor_group_chat_id } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 400, 'Name required');
  const finalSlug = (slug || String(name)).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
  try {
    const r = db.prepare('INSERT INTO departments(tenant_id,name,slug,head_telegram_id,head_username,assistant_telegram_id,assistant_username,monitor_group_chat_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(tid, String(name).trim(), finalSlug, head_telegram_id || null, head_username || null, assistant_telegram_id || null, assistant_username || null, monitor_group_chat_id || null);
    ok(res, { id: r.lastInsertRowid });
  } catch (e) { fail(res, 400, e.message); }
});

app.put('/api/departments/:id', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const existing = db.prepare('SELECT id FROM departments WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!existing) return fail(res, 404, 'Not found or not in your tenant');
  const allowed = ['name', 'slug', 'head_telegram_id', 'head_username', 'assistant_telegram_id', 'assistant_username', 'monitor_group_chat_id'];
  const fields = [], values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k] || null); }
  if (!fields.length) return ok(res, { id });
  values.push(id);
  db.prepare(`UPDATE departments SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  // Sync staff.department text kalau name berubah
  if ('name' in req.body) {
    db.prepare('UPDATE staff SET department = ? WHERE department_id = ?').run(String(req.body.name).trim(), id);
  }
  ok(res, { id });
});

app.delete('/api/departments/:id', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const existing = db.prepare('SELECT id FROM departments WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!existing) return fail(res, 404, 'Not found or not in your tenant');
  const cnt = db.prepare('SELECT COUNT(*) AS c FROM staff WHERE department_id = ?').get(id).c;
  if (cnt > 0) return fail(res, 400, `Tidak bisa hapus, masih ada ${cnt} staff. Pindah/hapus staff dulu.`);
  db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  ok(res, { id });
});

// ============ STAFF ============
app.get('/api/staff', auth, (req, res) => {
  const { shift, category, department } = req.query;
  const sc = scopeTenant(req);
  let q = 'SELECT * FROM staff WHERE 1=1' + sc.clause;
  const params = [...sc.params];
  if (shift) { q += ' AND current_shift = ?'; params.push(shift); }
  if (category) { q += ' AND category = ?'; params.push(category); }
  if (department) { q += ' AND department LIKE ?'; params.push('%' + department + '%'); }
  q += ' ORDER BY name';
  const rows = db.prepare(q).all(...params);
  ok(res, rows);
});

// Resolve dept_id + name dari body (terima department_id atau department text)
function resolveDept(tenantId, body) {
  if (body.department_id) {
    const d = db.prepare('SELECT id, name FROM departments WHERE id = ? AND tenant_id = ?').get(+body.department_id, tenantId);
    if (d) return { id: d.id, name: d.name };
  }
  if (body.department) {
    const d = db.prepare('SELECT id, name FROM departments WHERE tenant_id = ? AND LOWER(name) = LOWER(?)').get(tenantId, body.department);
    if (d) return { id: d.id, name: d.name };
    // Auto-create department kalau name unik
    const slug = String(body.department).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
    const r = db.prepare('INSERT INTO departments(tenant_id,name,slug) VALUES(?,?,?)').run(tenantId, String(body.department).trim(), slug);
    return { id: r.lastInsertRowid, name: String(body.department).trim() };
  }
  return { id: null, name: null };
}

app.post('/api/staff', auth, (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, 'Name required');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const dept = resolveDept(tid, b);
  const r = db.prepare(`INSERT INTO staff(tenant_id,name,category,current_shift,department,department_id,phone,telegram_id,telegram_username,join_date,is_active,is_approved)
                        VALUES(?,?,?,?,?,?,?,?,?,?,1,1)`).run(tid, b.name, b.category || 'indonesian', b.current_shift || 'morning', dept.name, dept.id, b.phone || null, b.telegram_id || null, b.telegram_username || null, b.join_date || null);
  ok(res, { id: r.lastInsertRowid });
});

function findStaffScoped(req, id) {
  const sc = scopeTenant(req);
  return db.prepare('SELECT * FROM staff WHERE id = ?' + sc.clause).get(id, ...sc.params);
}

app.put('/api/staff/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = findStaffScoped(req, id);
  if (!s) return fail(res, 404, 'Staff not found');
  const allowed = ['name', 'category', 'current_shift', 'phone', 'telegram_id', 'telegram_username', 'join_date'];
  const fields = [], values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
  // Handle department update via resolveDept (sync department + department_id)
  if ('department' in req.body || 'department_id' in req.body) {
    const dept = resolveDept(s.tenant_id, req.body);
    fields.push('department = ?', 'department_id = ?');
    values.push(dept.name, dept.id);
  }
  if (!fields.length) return ok(res, { id });
  values.push(id);
  db.prepare(`UPDATE staff SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  ok(res, { id });
});

app.put('/api/staff/:id/approve', auth, (req, res) => {
  const id = +req.params.id;
  const s = findStaffScoped(req, id);
  if (!s) return fail(res, 404, 'Staff not found');
  db.prepare('UPDATE staff SET is_approved = 1 WHERE id = ?').run(id);
  if (s.telegram_id) notifyApproved(s.telegram_id, s.name);
  emitLiveUpdate(s.tenant_id, 'staff_approved', { staff_id: id });
  ok(res, { id });
});

app.delete('/api/staff/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = findStaffScoped(req, id);
  if (!s) return fail(res, 404, 'Not found');
  const newVal = s.is_active ? 0 : 1;
  db.prepare('UPDATE staff SET is_active = ? WHERE id = ?').run(newVal, id);
  res.json({ success: true, message: `${s.name} ${newVal ? 'reactivated' : 'deactivated'}.` });
});

app.delete('/api/staff/:id/permanent', auth, (req, res) => {
  const id = +req.params.id;
  const s = findStaffScoped(req, id);
  if (!s) return fail(res, 404, 'Not found');
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  ok(res, { id });
});

// ============ ACTIVITY ============
function todayPP() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

// Server-Sent Events stream untuk real-time updates Live Board
app.get('/api/activity/live/stream', (req, res) => {
  // EventSource tidak support Authorization header, pakai query param
  const tok = (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null) || req.query.auth;
  if (!tok) return res.status(401).json({ success: false, message: 'Missing token' });
  let payload;
  try { payload = jwt.verify(tok, JWT_SECRET); } catch { return res.status(401).json({ success: false, message: 'Invalid token' }); }

  const isSuper = payload.role === 'super_admin';
  const override = req.query.tenant_id ? parseInt(req.query.tenant_id) : null;
  const viewTenantId = isSuper ? (override || null) : (payload.tenant_id || null);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {} };
  send({ type: 'connected', ts: Date.now() });

  const listener = (evt) => {
    if (isSuper && !viewTenantId) return send(evt); // super admin all
    if (evt.tenantId === viewTenantId) return send(evt);
  };
  liveBus.on('update', listener);

  // Heartbeat tiap 25 detik supaya koneksi tidak di-drop proxy
  const hb = setInterval(() => send({ type: 'ping', ts: Date.now() }), 25000);

  req.on('close', () => {
    liveBus.off('update', listener);
    clearInterval(hb);
  });
});

// Diagnostic: cek raw counts attendance hari ini & kemarin
app.get('/api/activity/live/debug', auth, (req, res) => {
  const today = todayPP();
  const yesterday = previousDate(today);
  const sc = scopeTenant(req);
  const todayAtt = db.prepare(`SELECT id, staff_id, date, shift, clock_in, clock_out, current_status FROM attendance WHERE date = ?${sc.clause} ORDER BY clock_in DESC`).all(today, ...sc.params);
  const yesterdayOpen = db.prepare(`SELECT id, staff_id, date, shift, clock_in, clock_out, current_status FROM attendance WHERE date = ? AND clock_out IS NULL${sc.clause}`).all(yesterday, ...sc.params);
  const totalActive = db.prepare(`SELECT COUNT(*) AS c FROM staff WHERE is_active = 1${sc.clause.replace('tenant_id', 'tenant_id')}`).get(...sc.params).c;
  const breakdown = {};
  todayAtt.forEach((a) => { breakdown[a.current_status || 'null'] = (breakdown[a.current_status || 'null'] || 0) + 1; });
  ok(res, {
    today,
    yesterday,
    tenant_id: req.tenant_id || 'all',
    total_active_staff: totalActive,
    today_attendance_count: todayAtt.length,
    today_attendance_status_breakdown: breakdown,
    yesterday_open_count: yesterdayOpen.length,
    today_attendance_sample: todayAtt.slice(0, 5),
    yesterday_open_sample: yesterdayOpen.slice(0, 5),
  });
});

app.get('/api/activity/live', auth, (req, res) => {
  const today = todayPP();
  const yesterday = previousDate(today);
  const sc = scopeTenant(req, 's.tenant_id');
  // Match attendance: hari ini → fallback shift kemarin yg masih open (Night cross-midnight).
  // UNIQUE(staff_id,date) memastikan satu row per join.
  const staff = db.prepare(`
    SELECT s.id, s.tenant_id, s.name, s.department, s.category, s.current_shift,
           a.date AS att_date, a.shift AS att_shift, a.clock_in, a.clock_out, a.late_minutes, a.current_status,
           a.break_start, a.break_limit,
           sd.status AS schedule_status,
           sd.shift AS scheduled_shift
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND (
      a.date = ?
      OR (
        a.date = ?
        AND a.clock_out IS NULL
        AND NOT EXISTS (SELECT 1 FROM attendance ax WHERE ax.staff_id = s.id AND ax.date = ?)
      )
    )
    LEFT JOIN schedule_daily sd ON sd.staff_id = s.id AND sd.date = ?
    WHERE s.is_active = 1${sc.clause}
    ORDER BY s.name
  `).all(today, yesterday, today, today, ...sc.params);

  // Shift yang efektif hari ini: dari schedule_daily (kalau ada) atau fallback ke current_shift
  staff.forEach((s) => {
    s.effective_shift = s.scheduled_shift || s.current_shift;
  });

  // Break quota usage per staff per type hari ini
  // Include break aktif (end_time IS NULL) — pakai elapsed sejak start_time
  const bsc = scopeTenant(req, 's2.tenant_id');
  const usage = db.prepare(`
    SELECT bl.staff_id, bl.type, COALESCE(SUM(
      CASE WHEN bl.end_time IS NOT NULL THEN bl.duration_minutes
      ELSE CAST((julianday('now') - julianday(bl.start_time)) * 1440 AS INTEGER)
      END
    ),0) AS used
    FROM break_log bl JOIN staff s2 ON s2.id = bl.staff_id
    WHERE DATE(bl.start_time) = ?${bsc.clause}
    GROUP BY bl.staff_id, bl.type
  `).all(today, ...bsc.params);
  const usageMap = {};
  usage.forEach((u) => { (usageMap[u.staff_id] = usageMap[u.staff_id] || {})[u.type] = u.used; });

  const limits = db.prepare('SELECT tenant_id, type, daily_quota_minutes FROM break_settings').all();
  const limitMap = {};
  limits.forEach((l) => { limitMap[`${l.tenant_id}_${l.type}`] = l.daily_quota_minutes; });

  const BREAK_TYPES = ['smoke', 'toilet', 'outside'];
  staff.forEach((s) => {
    s.break_quotas = {};
    BREAK_TYPES.forEach((t) => {
      const limit = limitMap[`${s.tenant_id}_${t}`] || 15;
      const used = (usageMap[s.id] || {})[t] || 0;
      s.break_quotas[t] = { limit, used, remaining: Math.max(0, limit - used) };
    });
  });

  const breaks = db.prepare(`
    SELECT bl.id, s.name, bl.type, bl.start_time, bl.limit_minutes
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.end_time IS NULL AND DATE(bl.start_time) = ?${sc.clause}
  `).all(today, ...sc.params).map((b) => ({
    ...b,
    elapsed_minutes: Math.max(0, (Date.now() - new Date(b.start_time).getTime()) / 60000),
  }));

  const hour = new Date(Date.now() + 7 * 3600000).getUTCHours();
  const currentShift = hour >= 9 && hour < 14 ? 'morning' : hour >= 14 && hour < 21 ? 'middle' : 'night';

  ok(res, { staff, active_breaks: breaks, stats: { current_shift: currentShift } });
});

app.get('/api/activity/active-breaks-qr', auth, (req, res) => {
  const today = todayPP();
  const sc = scopeTenant(req, 's.tenant_id');
  const rows = db.prepare(`
    SELECT bl.id, s.name AS staff_name, s.department, bl.type, bl.start_time, bl.qr_token, bl.qr_expires_at
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.end_time IS NULL AND bl.qr_token IS NOT NULL AND DATE(bl.start_time) = ?${sc.clause}
  `).all(today, ...sc.params);
  ok(res, rows);
});

app.post('/api/activity/force-clockout', auth, (req, res) => {
  const { staff_id, reason } = req.body || {};
  if (!staff_id) return fail(res, 400, 'staff_id required');
  const s = findStaffScoped(req, staff_id);
  if (!s) return fail(res, 404, 'Staff not in your tenant');
  const today = todayPP();
  // Cross-midnight: cek hari ini dulu, fallback ke shift kemarin yg masih open
  const att = findOpenAttendance(staff_id, today) || db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(staff_id, today);
  if (!att) return fail(res, 404, 'Tidak ada attendance terbuka untuk staff ini');
  if (att.clock_out) return fail(res, 400, 'Sudah clock-out');
  db.prepare('UPDATE attendance SET clock_out = ?, current_status = ? WHERE id = ?').run(new Date().toISOString(), 'offline', att.id);
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = CAST((julianday(?) - julianday(start_time)) * 1440 AS INTEGER) WHERE staff_id = ? AND end_time IS NULL').run(new Date().toISOString(), new Date().toISOString(), staff_id);
  emitLiveUpdate(s.tenant_id, 'force_clockout', { staff_id });
  notifyAdminOverride(s.tenant_id, { name: s.name, department: s.department, department_id: s.department_id }, 'force_clock_out', req.user?.username || 'admin', reason).catch(() => {});
  ok(res, { id: att.id });
});

// Admin paksa clock-in untuk staff yang lewat cutoff atau bukan jam shiftnya
app.post('/api/activity/force-clockin', auth, (req, res) => {
  const { staff_id, reason } = req.body || {};
  if (!staff_id) return fail(res, 400, 'staff_id required');
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') return fail(res, 403, 'Admin only');
  const s = findStaffScoped(req, staff_id);
  if (!s) return fail(res, 404, 'Staff not in your tenant');
  const today = todayPP();
  const existing = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(staff_id, today);
  if (existing) return fail(res, 400, 'Sudah ada attendance hari ini');
  const sched = db.prepare('SELECT shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(staff_id, today);
  const effectiveShift = sched?.shift || s.current_shift || 'morning';
  const now = new Date();
  // Compute lateness against shift_start
  const shiftRow = getEffectiveShiftTime(s.tenant_id, s.department_id, effectiveShift);
  let actualLate = 0;
  if (shiftRow?.start_time) {
    const [h, m] = shiftRow.start_time.split(':').map(Number);
    const shiftStart = new Date(now); shiftStart.setHours(h, m, 0, 0);
    const diff = Math.round((now - shiftStart) / 60000);
    if (diff > 0) actualLate = diff;
  }
  db.prepare('INSERT INTO attendance(tenant_id,staff_id,date,shift,clock_in,late_minutes,ip_address,current_status) VALUES(?,?,?,?,?,?,?,?)')
    .run(s.tenant_id, staff_id, today, effectiveShift, now.toISOString(), actualLate, 'admin-override', 'working');
  emitLiveUpdate(s.tenant_id, 'force_clock_in', { staff_id });
  notifyAdminOverride(s.tenant_id, { name: s.name, department: s.department, department_id: s.department_id }, 'force_clock_in', req.user?.username || 'admin', reason, { late_minutes: actualLate, shift: effectiveShift }).catch(() => {});
  ok(res, { staff_id, clock_in: now.toISOString(), late_minutes: actualLate, shift: effectiveShift });
});

app.get('/api/activity/log/:date', auth, (req, res) => {
  const { date } = req.params;
  const sc = scopeTenant(req, 's.tenant_id');
  const rows = db.prepare(`
    SELECT a.id, s.name, s.department, a.shift, a.clock_in, a.clock_out, a.late_minutes, a.ip_address, a.productive_ratio
    FROM attendance a
    JOIN staff s ON s.id = a.staff_id
    WHERE a.date = ?${sc.clause}
    ORDER BY a.clock_in
  `).all(date, ...sc.params);

  const sc2 = scopeTenant(req, 's2.tenant_id');
  const breaks = db.prepare(`
    SELECT bl.attendance_id, bl.type, bl.start_time, bl.end_time, bl.duration_minutes, bl.is_overtime,
           bl.ip_address_start, bl.ip_address_end
    FROM break_log bl JOIN staff s2 ON s2.id = bl.staff_id
    WHERE DATE(bl.start_time) = ?${sc2.clause}
  `).all(date, ...sc2.params);
  const byAtt = {};
  breaks.forEach((b) => { (byAtt[b.attendance_id] = byAtt[b.attendance_id] || []).push(b); });
  rows.forEach((r) => { r.breaks = byAtt[r.id] || []; });
  ok(res, rows);
});

// ============ SCHEDULE ============
app.get('/api/schedule/:ym', auth, (req, res) => {
  const ym = req.params.ym;
  const sc = scopeTenant(req);
  const sched = db.prepare('SELECT * FROM schedules WHERE month = ?' + sc.clause).get(ym, ...sc.params) || { status: null };
  const staff = db.prepare('SELECT id, name, category, department FROM staff WHERE is_active = 1' + sc.clause + ' ORDER BY name').all(...sc.params);
  const scsd = scopeTenant(req, 'sd.tenant_id');
  const days = db.prepare(`SELECT sd.* FROM schedule_daily sd WHERE sd.date LIKE ?${scsd.clause} ORDER BY sd.date`).all(ym + '-%', ...scsd.params);
  const byStaff = {};
  staff.forEach((s) => { byStaff[s.id] = { staff_id: s.id, name: s.name, category: s.category, department: s.department, days: [] }; });
  days.forEach((d) => { if (byStaff[d.staff_id]) byStaff[d.staff_id].days.push(d); });
  ok(res, { status: sched.status, staff_schedules: Object.values(byStaff) });
});

app.get('/api/schedule/rotation/:ym', auth, (req, res) => {
  ok(res, []);
});

app.post('/api/schedule/generate', auth, (req, res) => {
  const ym = req.body?.month;
  if (!ym) return fail(res, 400, 'month required');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const dept = req.body?.department ? String(req.body.department) : null;
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const staffQuery = 'SELECT id, current_shift FROM staff WHERE is_active = 1 AND tenant_id = ?' + (dept ? ' AND department = ?' : '');
  const staff = dept ? db.prepare(staffQuery).all(tid, dept) : db.prepare(staffQuery).all(tid);

  db.prepare('INSERT OR IGNORE INTO schedules(tenant_id,month,status) VALUES(?,?,?)').run(tid, ym, 'draft');
  db.prepare('UPDATE schedules SET status = ? WHERE tenant_id = ? AND month = ?').run('draft', tid, ym);

  const staffIds = staff.map((s) => s.id);
  const ins = db.prepare('INSERT OR IGNORE INTO schedule_daily(tenant_id,staff_id,date,status,shift) VALUES(?,?,?,?,?)');
  const delOne = db.prepare('DELETE FROM schedule_daily WHERE tenant_id = ? AND staff_id = ? AND date LIKE ? AND is_manual_override = 0');
  const tx = db.transaction(() => {
    staffIds.forEach((sid) => delOne.run(tid, sid, ym + '-%'));
    staff.forEach((s) => {
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${ym}-${String(d).padStart(2, '0')}`;
        const dow = new Date(y, m - 1, d).getDay();
        const off = dow === 0 && (s.id + d) % 4 === 0;
        ins.run(tid, s.id, date, off ? 'off' : 'work', s.current_shift);
      }
    });
  });
  tx();
  if (todayPP().startsWith(ym)) {
    try { syncStaffShiftsFromDaily(tid, todayPP()); } catch {}
  }
  ok(res, { month: ym, staff_affected: staff.length, department: dept });
});

app.put('/api/schedule/:ym/approve', auth, (req, res) => {
  const ym = req.params.ym;
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  db.prepare('INSERT OR IGNORE INTO schedules(tenant_id,month,status) VALUES(?,?,?)').run(tid, ym, 'draft');
  db.prepare('UPDATE schedules SET status = ? WHERE tenant_id = ? AND month = ?').run('approved', tid, ym);
  ok(res, { month: ym });
});

app.post('/api/schedule/:ym/copy-last-month', auth, (req, res) => {
  const ym = req.params.ym;
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const dept = req.body?.department ? String(req.body.department) : null;
  const [y, m] = ym.split('-').map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevYm = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const prevDays = dept
    ? db.prepare(`SELECT sd.staff_id, strftime("%d", sd.date) AS dd, sd.status, sd.shift
                  FROM schedule_daily sd JOIN staff s ON s.id = sd.staff_id
                  WHERE sd.tenant_id = ? AND sd.date LIKE ? AND s.department = ?`).all(tid, prevYm + '-%', dept)
    : db.prepare('SELECT staff_id, strftime("%d", date) AS dd, status, shift FROM schedule_daily WHERE tenant_id = ? AND date LIKE ?').all(tid, prevYm + '-%');
  if (!prevDays.length) return fail(res, 404, `No data for ${prevYm}${dept ? ` in ${dept}` : ''}`);
  const daysInMonth = new Date(y, m, 0).getDate();
  const ins = db.prepare('INSERT OR IGNORE INTO schedule_daily(tenant_id,staff_id,date,status,shift) VALUES(?,?,?,?,?)');
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO schedules(tenant_id,month,status) VALUES(?,?,?)').run(tid, ym, 'draft');
    prevDays.forEach((p) => {
      const day = parseInt(p.dd);
      if (day > daysInMonth) return;
      ins.run(tid, p.staff_id, `${ym}-${String(day).padStart(2, '0')}`, p.status, p.shift);
    });
  });
  tx();
  // Sync staff.current_shift kalau bulan yang di-copy mencakup hari ini
  if (todayPP().startsWith(ym)) {
    try { syncStaffShiftsFromDaily(tid, todayPP()); } catch {}
  }
  res.json({ success: true, message: `Copied ${prevDays.length} entries from ${prevYm}${dept ? ` (${dept})` : ''}` });
});

app.post('/api/schedule/:ym/import', auth, (req, res) => {
  const ym = req.params.ym;
  const entries = req.body?.entries || [];
  const errors = [];
  let imported = 0;
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const findStaff = db.prepare('SELECT id FROM staff WHERE LOWER(name) = LOWER(?) AND tenant_id = ?');
  const ins = db.prepare('INSERT INTO schedule_daily(tenant_id,staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,?,?,1) ON CONFLICT(staff_id,date) DO UPDATE SET status=excluded.status, shift=excluded.shift, is_manual_override=1');
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO schedules(tenant_id,month,status) VALUES(?,?,?)').run(tid, ym, 'draft');
    for (const e of entries) {
      const s = findStaff.get(e.staff_name, tid);
      if (!s) { errors.push(`Staff not found: ${e.staff_name}`); continue; }
      try { ins.run(tid, s.id, e.date, e.status, e.shift); imported++; }
      catch (err) { errors.push(`${e.staff_name} ${e.date}: ${err.message}`); }
    }
  });
  tx();
  if (todayPP().startsWith(ym)) {
    try { syncStaffShiftsFromDaily(tid, todayPP()); } catch {}
  }
  res.json({ success: true, message: `Imported ${imported} entries${errors.length ? ` (${errors.length} errors)` : ''}`, errors });
});

app.get('/api/schedule/:ym/export', auth, async (req, res) => {
  const ym = req.params.ym;
  const dept = req.query.department ? String(req.query.department) : null;
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const sc = scopeTenant(req);
  let staffQ = 'SELECT id, name, department FROM staff WHERE is_active = 1' + sc.clause;
  const staffP = [...sc.params];
  if (dept) { staffQ += ' AND department = ?'; staffP.push(dept); }
  staffQ += ' ORDER BY department, name';
  const staff = db.prepare(staffQ).all(...staffP);
  const days = db.prepare('SELECT staff_id, date, status, shift FROM schedule_daily WHERE date LIKE ?' + sc.clause).all(ym + '-%', ...sc.params);
  const key = (sid, d) => `${sid}_${d}`;
  const lookup = {};
  days.forEach((x) => { lookup[key(x.staff_id, x.date)] = x; });

  // Group by department
  const groups = {};
  staff.forEach((s) => {
    const dept = s.department || '(Tanpa Department)';
    if (!groups[dept]) groups[dept] = [];
    groups[dept].push(s);
  });
  const sortedDepts = Object.keys(groups).sort((a, b) => a.localeCompare(b));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Schedule ${ym}`);
  const header = ['Name', 'Department', ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  ws.addRow(header);
  const shiftMap = { morning: 'M', middle: 'D', night: 'N' };

  sortedDepts.forEach((dept, idx) => {
    // Department separator row
    const sepRow = ws.addRow([`== ${dept.toUpperCase()} (${groups[dept].length}) ==`]);
    sepRow.font = { bold: true, color: { argb: 'FF34D399' } };
    sepRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };

    groups[dept].forEach((s) => {
      const row = [s.name, s.department || ''];
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${ym}-${String(d).padStart(2, '0')}`;
        const entry = lookup[key(s.id, date)];
        if (!entry) row.push('');
        else if (entry.status === 'work') row.push(shiftMap[entry.shift] || 'W');
        else row.push(entry.status.toUpperCase());
      }
      ws.addRow(row);
    });
  });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=schedule-${ym}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

app.post('/api/schedule/daily', auth, (req, res) => {
  const { staff_id, date, status, shift, is_manual_override } = req.body || {};
  if (!staff_id || !date) return fail(res, 400, 'staff_id and date required');
  const s = findStaffScoped(req, staff_id);
  if (!s) return fail(res, 404, 'Staff not in your tenant');
  const r = db.prepare(`INSERT INTO schedule_daily(tenant_id,staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,?,?,?)
                        ON CONFLICT(staff_id,date) DO UPDATE SET status=excluded.status, shift=excluded.shift, is_manual_override=excluded.is_manual_override`)
                .run(s.tenant_id, staff_id, date, status || 'work', shift || 'morning', is_manual_override ? 1 : 0);
  // Kalau edit jadwal hari ini → sync staff.current_shift langsung supaya Staff page update
  if (date === todayPP()) {
    try { syncStaffShiftsFromDaily(s.tenant_id, date); } catch {}
  }
  emitLiveUpdate(s.tenant_id, 'schedule_edited', { staff_id, date });
  ok(res, { id: r.lastInsertRowid || null });
});

app.put('/api/schedule/daily/:id', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const existing = db.prepare('SELECT id, tenant_id, staff_id, date FROM schedule_daily WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!existing) return fail(res, 404, 'Not found or not in your tenant');
  const { status, shift, is_manual_override } = req.body || {};
  const fields = [], values = [];
  if (status !== undefined) { fields.push('status = ?'); values.push(status); }
  if (shift !== undefined) { fields.push('shift = ?'); values.push(shift); }
  if (is_manual_override !== undefined) { fields.push('is_manual_override = ?'); values.push(is_manual_override ? 1 : 0); }
  if (!fields.length) return ok(res, { id });
  values.push(id);
  db.prepare(`UPDATE schedule_daily SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  if (existing.date === todayPP()) {
    try { syncStaffShiftsFromDaily(existing.tenant_id, existing.date); } catch {}
  }
  emitLiveUpdate(existing.tenant_id, 'schedule_edited', { staff_id: existing.staff_id, date: existing.date });
  ok(res, { id });
});

// ============ SWAP ============
const swapJoinBase = `SELECT sw.id, sw.target_date, sw.current_shift, sw.reason, sw.status, sw.reject_reason, sw.created_at,
                             s.name AS requester_name, s.department AS requester_dept
                      FROM swap_requests sw
                      JOIN staff s ON s.id = sw.requester_id`;

app.get('/api/swap/pending', auth, (req, res) => {
  const sc = scopeTenant(req, 'sw.tenant_id');
  ok(res, db.prepare(swapJoinBase + ' WHERE sw.status = ?' + sc.clause + ' ORDER BY sw.created_at DESC').all('pending', ...sc.params));
});
app.get('/api/swap/history', auth, (req, res) => {
  const sc = scopeTenant(req, 'sw.tenant_id');
  ok(res, db.prepare(swapJoinBase + ' WHERE 1=1' + sc.clause + ' ORDER BY sw.created_at DESC').all(...sc.params));
});
app.put('/api/swap/:id/approve', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const sw = db.prepare('SELECT * FROM swap_requests WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!sw) return fail(res, 404, 'Not found or not in your tenant');
  if (sw.status !== 'pending') return fail(res, 400, 'Already processed');
  const apply = applySwapApproval(sw);
  if (apply.error) return fail(res, 400, apply.error);
  db.prepare('UPDATE swap_requests SET status = ? WHERE id = ?').run('approved', id);
  emitLiveUpdate(sw.tenant_id, 'swap_approved', { swap_id: id });
  pushSwapResultSnapshot(sw.tenant_id, sw).catch(() => {});
  ok(res, { id });
});
app.put('/api/swap/:id/reject', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const r = db.prepare('SELECT id FROM swap_requests WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!r) return fail(res, 404, 'Not found or not in your tenant');
  const { reject_reason } = req.body || {};
  db.prepare('UPDATE swap_requests SET status = ?, reject_reason = ? WHERE id = ?').run('rejected', reject_reason || '', id);
  ok(res, { id });
});

// ============ LEAVE / CUTI ============
function getLeaveConfig(tenantId) {
  const cfg = getTenantSetting(tenantId, 'leave_config', null) || {};
  return {
    enabled: cfg.enabled !== false,
    days_per_period: Number.isFinite(+cfg.days_per_period) && +cfg.days_per_period > 0 ? +cfg.days_per_period : 12,
    period_months: Number.isFinite(+cfg.period_months) && +cfg.period_months > 0 ? +cfg.period_months : 6,
  };
}
function getPeriodKeyForDate(dateStr, periodMonths = 6) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-11
  if (periodMonths === 6) return `${y}-H${m < 6 ? 1 : 2}`;
  if (periodMonths === 3) return `${y}-Q${Math.floor(m / 3) + 1}`;
  if (periodMonths === 12) return `${y}`;
  // generic: split year into ceil(12/periodMonths) bins
  const bin = Math.floor(m / periodMonths) + 1;
  return `${y}-P${bin}`;
}
function periodDateRange(periodKey, periodMonths = 6) {
  // returns { start, end } inclusive YYYY-MM-DD
  if (periodMonths === 6) {
    const [y, h] = periodKey.split('-H');
    const yr = +y;
    if (h === '1') return { start: `${yr}-01-01`, end: `${yr}-06-30` };
    if (h === '2') return { start: `${yr}-07-01`, end: `${yr}-12-31` };
  }
  if (periodMonths === 12) return { start: `${periodKey}-01-01`, end: `${periodKey}-12-31` };
  return null;
}
function diffDaysInclusive(start, end) {
  const a = new Date(start + 'T00:00:00');
  const b = new Date(end + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;
  return Math.floor((b - a) / 86400000) + 1;
}
function getLeaveQuota(tenantId, staffId, cfg) {
  const c = cfg || getLeaveConfig(tenantId);
  const today = new Date().toISOString().slice(0, 10);
  const periodKey = getPeriodKeyForDate(today, c.period_months);
  const range = periodDateRange(periodKey, c.period_months);
  const rows = db.prepare(`SELECT status, days FROM leave_requests
                           WHERE tenant_id = ? AND staff_id = ? AND period_key = ? AND status IN ('pending','approved')`)
    .all(tenantId, staffId, periodKey);
  let used = 0, pending = 0;
  for (const r of rows) {
    if (r.status === 'approved') used += r.days;
    else if (r.status === 'pending') pending += r.days;
  }
  return {
    enabled: c.enabled,
    period_key: periodKey,
    period_months: c.period_months,
    period_start: range?.start || null,
    period_end: range?.end || null,
    days_per_period: c.days_per_period,
    used,
    pending,
    remaining: Math.max(0, c.days_per_period - used - pending),
  };
}

const leaveJoinBase = `SELECT lr.id, lr.start_date, lr.end_date, lr.days, lr.reason, lr.status, lr.reject_reason,
                              lr.period_key, lr.created_at, lr.decided_at,
                              s.name AS staff_name, s.department AS staff_dept
                       FROM leave_requests lr
                       JOIN staff s ON s.id = lr.staff_id`;

app.get('/api/leave/pending', auth, (req, res) => {
  const sc = scopeTenant(req, 'lr.tenant_id');
  ok(res, db.prepare(leaveJoinBase + " WHERE lr.status = 'pending'" + sc.clause + ' ORDER BY lr.created_at DESC').all(...sc.params));
});
app.get('/api/leave/history', auth, (req, res) => {
  const sc = scopeTenant(req, 'lr.tenant_id');
  ok(res, db.prepare(leaveJoinBase + ' WHERE 1=1' + sc.clause + ' ORDER BY lr.created_at DESC LIMIT 200').all(...sc.params));
});
app.put('/api/leave/:id/approve', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const lr = db.prepare('SELECT * FROM leave_requests WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!lr) return fail(res, 404, 'Not found or not in your tenant');
  if (lr.status !== 'pending') return fail(res, 400, 'Already processed');
  const apply = applyLeaveApproval(lr);
  if (apply.error) return fail(res, 400, apply.error);
  emitLiveUpdate(lr.tenant_id, 'leave_approved', { leave_id: id });
  pushLeaveResultSnapshot(lr.tenant_id, lr).catch(() => {});
  ok(res, { id });
});
app.put('/api/leave/:id/reject', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const lr = db.prepare('SELECT id, tenant_id FROM leave_requests WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!lr) return fail(res, 404, 'Not found or not in your tenant');
  const { reject_reason } = req.body || {};
  db.prepare("UPDATE leave_requests SET status = 'rejected', reject_reason = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(reject_reason || '', id);
  emitLiveUpdate(lr.tenant_id, 'leave_rejected', { leave_id: id });
  ok(res, { id });
});

// ============ REPORTS ============
function dateRange(ym, from, to) {
  const start = from || `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const end = to || `${ym}-${String(last).padStart(2, '0')}`;
  return { start, end };
}

function deptFilterSql(req, alias = 's.department') {
  const dept = req.query.department ? String(req.query.department) : null;
  return dept ? { clause: ` AND ${alias} = ?`, params: [dept] } : { clause: '', params: [] };
}

app.get('/api/reports/monthly/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const df = deptFilterSql(req);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT a.staff_id) AS unique_staff,
           COUNT(*) AS total_records,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(a.late_minutes),0) AS total_late_minutes,
           COALESCE(SUM(a.break_violations),0) AS total_break_violations,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio
    FROM attendance a JOIN staff s ON s.id = a.staff_id
    WHERE a.date BETWEEN ? AND ?${sc.clause}${df.clause}
  `).get(start, end, ...sc.params, ...df.params);
  ok(res, row);
});

app.get('/api/reports/attendance/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const df = deptFilterSql(req);
  const rows = db.prepare(`
    SELECT s.id AS staff_id, s.name, s.department, s.current_shift,
           COUNT(DISTINCT CASE WHEN a.clock_in IS NOT NULL THEN a.date END) AS days_present,
           COUNT(DISTINCT CASE WHEN sd.status = 'off' THEN sd.date END) AS days_off,
           COALESCE(SUM(a.late_minutes),0) AS total_late_minutes,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    LEFT JOIN schedule_daily sd ON sd.staff_id = s.id AND sd.date BETWEEN ? AND ?
    WHERE s.is_active = 1${sc.clause}${df.clause}
    GROUP BY s.id
    ORDER BY s.department, s.name
  `).all(start, end, start, end, ...sc.params, ...df.params);
  ok(res, rows);
});

app.get('/api/reports/violations/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const df = deptFilterSql(req);
  const rows = db.prepare(`
    SELECT s.name, s.department, bl.type, bl.duration_minutes, bl.limit_minutes, DATE(bl.start_time) AS date
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.is_overtime = 1 AND DATE(bl.start_time) BETWEEN ? AND ?${sc.clause}${df.clause}
    ORDER BY bl.start_time DESC
  `).all(start, end, ...sc.params, ...df.params);
  ok(res, rows);
});

app.get('/api/reports/productivity/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const df = deptFilterSql(req);
  const rows = db.prepare(`
    SELECT s.id AS staff_id, s.name, s.department, s.current_shift,
           COUNT(DISTINCT a.date) AS days_worked,
           COALESCE(SUM(a.late_minutes),0) AS total_late_minutes,
           COALESCE(SUM(a.overbreak_minutes),0) AS total_overbreak_minutes,
           COALESCE(SUM(a.expected_work_minutes),0) AS total_expected_minutes,
           COALESCE(SUM(a.productive_score),0) AS total_productive_score,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(a.break_violations),0) AS overtime_breaks
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1${sc.clause}${df.clause}
    GROUP BY s.id
  `).all(start, end, ...sc.params, ...df.params);
  // Hitung cumulative_productive_ratio = sum(score) / sum(expected) * 100
  rows.forEach((r) => {
    r.cumulative_productive_ratio = r.total_expected_minutes > 0
      ? Math.round((r.total_productive_score / r.total_expected_minutes) * 1000) / 10
      : 0;
  });
  rows.sort((a, b) => (b.cumulative_productive_ratio || 0) - (a.cumulative_productive_ratio || 0));
  ok(res, rows);
});

app.get('/api/reports/export/:ym', auth, async (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const df = deptFilterSql(req);
  const rows = db.prepare(`
    SELECT s.name, s.department, s.current_shift,
           COUNT(DISTINCT CASE WHEN a.clock_in IS NOT NULL THEN a.date END) AS days_present,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1${sc.clause}${df.clause}
    GROUP BY s.id
    ORDER BY s.department, s.name
  `).all(start, end, ...sc.params, ...df.params);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow(['Name', 'Dept', 'Shift', 'Days Present', 'Work (min)', 'Break (min)', 'Avg Productive %']);
  rows.forEach((r) => ws.addRow([r.name, r.department, r.current_shift, r.days_present, r.total_work_minutes, r.total_break_minutes, Number(r.avg_productive_ratio).toFixed(1)]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const deptSuffix = req.query.department ? `-${String(req.query.department).replace(/\s+/g, '_')}` : '';
  res.setHeader('Content-Disposition', `attachment; filename=report-${req.params.ym}${deptSuffix}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

// Detail produktivitas harian per staff dalam 1 bulan/range
app.get('/api/reports/productivity-detail/:staffId/:ym', auth, (req, res) => {
  const staffId = +req.params.staffId;
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const staff = db.prepare('SELECT s.id, s.name, s.department, s.current_shift FROM staff s WHERE s.id = ?' + sc.clause).get(staffId, ...sc.params);
  if (!staff) return fail(res, 404, 'Staff tidak ditemukan / bukan tenant Anda');

  // Ambil semua schedule + attendance dalam range, join per tanggal
  const rows = db.prepare(`
    SELECT sd.date, sd.status AS sched_status, sd.shift AS sched_shift,
           a.shift AS att_shift, a.clock_in, a.clock_out,
           a.late_minutes, a.total_work_minutes, a.total_break_minutes,
           a.expected_work_minutes, a.productive_score, a.overbreak_minutes,
           a.productive_ratio
    FROM schedule_daily sd
    LEFT JOIN attendance a ON a.staff_id = sd.staff_id AND a.date = sd.date
    WHERE sd.staff_id = ? AND sd.date BETWEEN ? AND ?
    ORDER BY sd.date
  `).all(staffId, start, end);

  // Kalau staff belum punya schedule_daily untuk tanggal tertentu tapi ada attendance,
  // ambil attendance-nya juga supaya tidak hilang
  const attOnly = db.prepare(`
    SELECT a.date, NULL AS sched_status, NULL AS sched_shift,
           a.shift AS att_shift, a.clock_in, a.clock_out,
           a.late_minutes, a.total_work_minutes, a.total_break_minutes,
           a.expected_work_minutes, a.productive_score, a.overbreak_minutes,
           a.productive_ratio
    FROM attendance a
    WHERE a.staff_id = ? AND a.date BETWEEN ? AND ?
      AND NOT EXISTS (SELECT 1 FROM schedule_daily sd WHERE sd.staff_id = a.staff_id AND sd.date = a.date)
    ORDER BY a.date
  `).all(staffId, start, end);

  const merged = [...rows, ...attOnly].sort((a, b) => a.date.localeCompare(b.date));

  // Hitung running cumulative
  let cumScore = 0, cumExpected = 0;
  const days = merged.map((r) => {
    const isWork = r.sched_status === 'work' || (!r.sched_status && r.clock_in);
    const expected = r.expected_work_minutes || 0;
    const score = r.productive_score || 0;
    if (isWork) {
      cumExpected += expected;
      cumScore += score;
    }
    return {
      date: r.date,
      sched_status: r.sched_status || (r.clock_in ? 'work' : null),
      shift: r.att_shift || r.sched_shift || null,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      late_minutes: r.late_minutes || 0,
      work_minutes: r.total_work_minutes || 0,
      break_minutes: r.total_break_minutes || 0,
      overbreak_minutes: r.overbreak_minutes || 0,
      expected_minutes: expected,
      score: score,
      daily_ratio: r.productive_ratio || 0,
      cumulative_score: cumScore,
      cumulative_expected: cumExpected,
      cumulative_ratio: cumExpected > 0 ? Math.round((cumScore / cumExpected) * 1000) / 10 : 0,
    };
  });

  ok(res, {
    staff: { id: staff.id, name: staff.name, department: staff.department, current_shift: staff.current_shift },
    range: { start, end },
    days,
    summary: {
      total_days: days.length,
      work_days: days.filter((d) => d.sched_status === 'work').length,
      off_days: days.filter((d) => d.sched_status === 'off').length,
      sick_days: days.filter((d) => d.sched_status === 'sick').length,
      leave_days: days.filter((d) => d.sched_status === 'leave').length,
      total_late_minutes: days.reduce((a, d) => a + d.late_minutes, 0),
      total_overbreak_minutes: days.reduce((a, d) => a + d.overbreak_minutes, 0),
      total_expected_minutes: cumExpected,
      total_productive_score: cumScore,
      cumulative_ratio: cumExpected > 0 ? Math.round((cumScore / cumExpected) * 1000) / 10 : 0,
    },
  });
});

// ============ RESET TEST DATA (admin only) ============
// Reset attendance + break_log untuk 1 staff dalam date range (default: bulan dipilih).
app.delete('/api/reports/reset-staff/:staffId', auth, (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') return fail(res, 403, 'Admin only');
  const staffId = +req.params.staffId;
  const sc = scopeTenant(req);
  const staff = db.prepare('SELECT id, name, tenant_id FROM staff WHERE id = ?' + sc.clause).get(staffId, ...sc.params);
  if (!staff) return fail(res, 404, 'Staff tidak ditemukan / bukan tenant Anda');
  const { from, to } = req.query;
  if (!from || !to) return fail(res, 400, 'from & to (YYYY-MM-DD) wajib');
  const att = db.prepare('DELETE FROM attendance WHERE staff_id = ? AND date BETWEEN ? AND ?').run(staffId, from, to);
  const brk = db.prepare("DELETE FROM break_log WHERE staff_id = ? AND DATE(start_time) BETWEEN ? AND ?").run(staffId, from, to);
  emitLiveUpdate(staff.tenant_id, 'data_reset', { staff_id: staffId });
  ok(res, { staff_name: staff.name, attendance_deleted: att.changes, break_log_deleted: brk.changes, range: { from, to } });
});

// Reset SEMUA staff dalam tenant + date range (untuk testing). Wajib pass confirm=YES.
app.delete('/api/reports/reset-all', auth, (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') return fail(res, 403, 'Admin only');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const { from, to, confirm } = req.query;
  if (!from || !to) return fail(res, 400, 'from & to (YYYY-MM-DD) wajib');
  if (confirm !== 'YES') return fail(res, 400, 'Tambah confirm=YES untuk konfirmasi reset semua staff');
  const att = db.prepare('DELETE FROM attendance WHERE tenant_id = ? AND date BETWEEN ? AND ?').run(tid, from, to);
  const brk = db.prepare("DELETE FROM break_log WHERE tenant_id = ? AND DATE(start_time) BETWEEN ? AND ?").run(tid, from, to);
  emitLiveUpdate(tid, 'data_reset', { all: true });
  ok(res, { tenant_id: tid, attendance_deleted: att.changes, break_log_deleted: brk.changes, range: { from, to } });
});

// ============ SETTINGS ============
app.get('/api/settings', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const rows = db.prepare('SELECT key, value FROM settings WHERE tenant_id = ?').all(tid);
  const settings = {};
  rows.forEach((r) => {
    try { settings[r.key] = { value: JSON.parse(r.value) }; }
    catch { settings[r.key] = { value: r.value }; }
  });
  if (settings.bot_config?.value?.bot_token) {
    const t = settings.bot_config.value.bot_token;
    settings.bot_config.value.bot_token_masked = t.length > 8 ? '****' + t.slice(-6) : '****';
    settings.bot_config.value.bot_token = '';
  }
  const break_settings = db.prepare('SELECT type, daily_quota_minutes FROM break_settings WHERE tenant_id = ?').all(tid);
  const shifts = db.prepare('SELECT name, start_time, end_time FROM shifts WHERE tenant_id = ?').all(tid);
  // Per-department overrides (semua dept dalam tenant)
  const dept_break_settings = db.prepare('SELECT department_id, type, daily_quota_minutes FROM dept_break_settings WHERE tenant_id = ?').all(tid);
  const dept_shifts = db.prepare('SELECT department_id, name, start_time, end_time FROM dept_shifts WHERE tenant_id = ?').all(tid);
  ok(res, { settings, break_settings, shifts, dept_break_settings, dept_shifts });
});

app.put('/api/settings/breaks', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const body = req.body || {};
  const deptId = body._department_id ? +body._department_id : null;
  const data = { ...body }; delete data._department_id;
  if (deptId) {
    const upsert = db.prepare('INSERT INTO dept_break_settings(tenant_id,department_id,type,daily_quota_minutes) VALUES(?,?,?,?) ON CONFLICT(tenant_id,department_id,type) DO UPDATE SET daily_quota_minutes=excluded.daily_quota_minutes');
    for (const [type, vals] of Object.entries(data)) upsert.run(tid, deptId, type, vals.daily_quota_minutes);
  } else {
    const upsert = db.prepare('INSERT INTO break_settings(tenant_id,type,daily_quota_minutes) VALUES(?,?,?) ON CONFLICT(tenant_id,type) DO UPDATE SET daily_quota_minutes=excluded.daily_quota_minutes');
    for (const [type, vals] of Object.entries(data)) upsert.run(tid, type, vals.daily_quota_minutes);
  }
  ok(res, { department_id: deptId });
});

app.put('/api/settings/shift-times', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const body = req.body || {};
  const deptId = body._department_id ? +body._department_id : null;
  const data = { ...body }; delete data._department_id;
  if (deptId) {
    const upsert = db.prepare('INSERT INTO dept_shifts(tenant_id,department_id,name,start_time,end_time) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,department_id,name) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time');
    for (const [name, vals] of Object.entries(data)) upsert.run(tid, deptId, name, vals.start + ':00', vals.end + ':00');
  } else {
    const upsert = db.prepare('INSERT INTO shifts(tenant_id,name,start_time,end_time) VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time');
    for (const [name, vals] of Object.entries(data)) upsert.run(tid, name, vals.start + ':00', vals.end + ':00');
  }
  ok(res, { department_id: deptId });
});

// Debug: cek effective QR routing untuk tenant saat ini
app.get('/api/settings/qr-group/debug', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const qrGroup = getTenantSetting(tid, 'qr_monitor_group_chat_id', null);
  const botConfig = getTenantSetting(tid, 'bot_config', {}) || {};
  ok(res, {
    tenant_id: tid,
    qr_monitor_group_chat_id: qrGroup,
    tenant_monitor_group_chat_id: botConfig.monitor_group_chat_id || null,
    qr_routed_to: qrGroup ? String(qrGroup).trim() : (botConfig.monitor_group_chat_id || null),
    note: qrGroup ? 'QR akan dikirim ke qr_monitor_group_chat_id' : 'QR akan dikirim ke grup dept / tenant default (fallback)',
  });
});

// Trigger daily briefing manually (admin testing)
app.post('/api/settings/daily-briefing/test', auth, async (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'tenant required');
  try {
    await notifyDailyOffSummary(tid, todayPP());
    ok(res, { sent: true });
  } catch (e) { fail(res, 500, e.message); }
});

// Delete dept override (back to tenant default)
app.delete('/api/settings/dept-overrides/:deptId', auth, (req, res) => {
  const tid = writeTenantId(req);
  const deptId = +req.params.deptId;
  if (!tid || !deptId) return fail(res, 400, 'tenant + dept required');
  db.prepare('DELETE FROM dept_break_settings WHERE tenant_id = ? AND department_id = ?').run(tid, deptId);
  db.prepare('DELETE FROM dept_shifts WHERE tenant_id = ? AND department_id = ?').run(tid, deptId);
  ok(res, { department_id: deptId });
});

const KV_ROUTES = {
  '/api/settings/ip-whitelist': (body) => ['ip_whitelist', body],
  '/api/settings/offday-rules': (body) => ['off_day_rules', body],
  '/api/settings/telegram': (body) => ['telegram_admin_chat_ids', body.admin_chat_ids || []],
  '/api/settings/notification-prefs': (body) => ['notification_prefs', body],
  '/api/settings/qr-required': (body) => ['qr_required', !!body.enabled],
  '/api/settings/late-grace': (body) => ['late_grace_minutes', +body.minutes || 0],
  '/api/settings/registration-pin': (body) => ['registration_pin', String(body.pin || '')],
  '/api/settings/motivation-quotes': (body) => ['motivation_quotes', {
    start: Array.isArray(body.start) ? body.start.map((s) => String(s).trim()).filter(Boolean) : [],
    end: Array.isArray(body.end) ? body.end.map((s) => String(s).trim()).filter(Boolean) : [],
  }],
  '/api/settings/qr-group': (body) => ['qr_monitor_group_chat_id', String(body.chat_id || '').trim() || null],
  '/api/settings/clock-in-window': (body) => ['clock_in_open_offset_minutes', Number.isFinite(+body.offset_minutes) && +body.offset_minutes >= 0 ? +body.offset_minutes : 60],
  '/api/settings/clock-in-cutoff': (body) => ['clock_in_late_cutoff_minutes', Number.isFinite(+body.minutes) && +body.minutes >= 0 ? +body.minutes : 240],
  '/api/settings/daily-briefing': (body) => ['daily_briefing', {
    enabled: body.enabled !== false,
    hour: Number.isInteger(+body.hour) && +body.hour >= 0 && +body.hour <= 23 ? +body.hour : 6,
  }],
  '/api/settings/leave-config': (body) => ['leave_config', {
    enabled: body.enabled !== false,
    days_per_period: Number.isFinite(+body.days_per_period) && +body.days_per_period > 0 ? +body.days_per_period : 12,
    period_months: [3, 6, 12].includes(+body.period_months) ? +body.period_months : 6,
  }],
  '/api/settings/swap-modes': (body) => ['swap_modes_enabled', {
    sick: body.sick !== false,
    move_off: body.move_off !== false,
    trade: body.trade !== false,
  }],
};
for (const [p, fn] of Object.entries(KV_ROUTES)) {
  app.put(p, auth, (req, res) => {
    const tid = writeTenantId(req);
    if (!tid) return fail(res, 400, 'No tenant context');
    const [k, v] = fn(req.body || {});
    setTenantSetting(tid, k, v);
    ok(res, { [k]: v });
  });
}

app.get('/api/settings/workstations', auth, (req, res) => {
  const sc = scopeTenant(req);
  ok(res, db.prepare('SELECT * FROM workstations WHERE 1=1' + sc.clause + ' ORDER BY name').all(...sc.params));
});
app.post('/api/settings/workstations', auth, (req, res) => {
  const { name, department } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const tokWork = crypto.randomBytes(6).toString('hex');
  const tokIn = crypto.randomBytes(6).toString('hex');
  const tokOut = crypto.randomBytes(6).toString('hex');
  const r = db.prepare('INSERT INTO workstations(tenant_id,name,department,qr_token,qr_token_in,qr_token_out,is_active) VALUES(?,?,?,?,?,?,1)').run(tid, name, department || null, tokWork, tokIn, tokOut);
  ok(res, { id: r.lastInsertRowid, qr_token: tokWork, qr_token_in: tokIn, qr_token_out: tokOut });
});
app.put('/api/settings/workstations/:id/toggle', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const r = db.prepare('SELECT id FROM workstations WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!r) return fail(res, 404, 'Not found');
  db.prepare('UPDATE workstations SET is_active = 1 - is_active WHERE id = ?').run(id);
  ok(res, { id });
});
app.delete('/api/settings/workstations/:id', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const r = db.prepare('SELECT id FROM workstations WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!r) return fail(res, 404, 'Not found');
  db.prepare('DELETE FROM workstations WHERE id = ?').run(id);
  ok(res, {});
});

// ============ BOT CONFIG ============
app.get('/api/bot/status', auth, (req, res) => {
  const tid = writeTenantId(req);
  ok(res, getBotStatus(tid));
});

app.put('/api/settings/bot-config', auth, async (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const { bot_token, monitor_group_chat_id, miniapp_url } = req.body || {};
  const existing = getTenantSetting(tid, 'bot_config', {}) || {};
  const newToken = (bot_token || '').trim();
  const cfg = {
    bot_token: newToken || existing.bot_token || '',
    monitor_group_chat_id: (monitor_group_chat_id ?? existing.monitor_group_chat_id ?? '').toString().trim(),
    miniapp_url: (miniapp_url ?? existing.miniapp_url ?? '').trim(),
  };
  setTenantSetting(tid, 'bot_config', cfg);
  const status = await reloadBot(tid);
  res.json({ success: true, status });
});

// ============ EFFECTIVE SETTINGS RESOLVERS ============
// Resolution: dept-specific override → tenant default
function getEffectiveBreakLimit(tenantId, departmentId, type) {
  if (departmentId) {
    const dept = db.prepare('SELECT daily_quota_minutes FROM dept_break_settings WHERE tenant_id = ? AND department_id = ? AND type = ?').get(tenantId, departmentId, type);
    if (dept && dept.daily_quota_minutes != null) return dept.daily_quota_minutes;
  }
  const tenant = db.prepare('SELECT daily_quota_minutes FROM break_settings WHERE tenant_id = ? AND type = ?').get(tenantId, type);
  return tenant?.daily_quota_minutes ?? 15;
}

function getEffectiveShiftTime(tenantId, departmentId, name) {
  if (departmentId) {
    const dept = db.prepare('SELECT start_time, end_time FROM dept_shifts WHERE tenant_id = ? AND department_id = ? AND name = ?').get(tenantId, departmentId, name);
    if (dept && dept.start_time) return dept;
  }
  return db.prepare('SELECT start_time, end_time FROM shifts WHERE tenant_id = ? AND name = ?').get(tenantId, name) || {};
}

function previousDate(dateStr) {
  return new Date(new Date(dateStr + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
}

// Hitung durasi shift dalam menit (handle cross-midnight: end < start = +24h)
function shiftDurationMinutes(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const [sh, sm] = String(startTime).split(':').map(Number);
  const [eh, em] = String(endTime).split(':').map(Number);
  const startM = sh * 60 + sm;
  let endM = eh * 60 + em;
  if (endM <= startM) endM += 24 * 60;
  return endM - startM;
}

// Total kuota break per hari (sum semua break types) — pakai dept override kalau ada
function getTotalBreakQuota(tenantId, departmentId) {
  let total = 0;
  for (const t of ['smoke', 'toilet', 'outside']) {
    total += getEffectiveBreakLimit(tenantId, departmentId, t) || 0;
  }
  return total;
}

// Hitung baseline kerja efektif per hari = shift_duration - break_quota
function computeExpectedWorkMinutes(tenantId, departmentId, shiftName) {
  const sh = getEffectiveShiftTime(tenantId, departmentId, shiftName);
  const shiftMin = shiftDurationMinutes(sh.start_time, sh.end_time);
  const breakQuota = getTotalBreakQuota(tenantId, departmentId);
  return Math.max(0, shiftMin - breakQuota);
}

// Hitung kapan tombol Start aktif: shift_start - offset_minutes (dalam WIB hari ini).
// Return Date object (UTC), atau null kalau shift_time tidak ditemukan.
function computeClockInOpenTime(tenantId, departmentId, shiftName, dateStr, offsetMin) {
  const sh = getEffectiveShiftTime(tenantId, departmentId, shiftName);
  if (!sh.start_time) return null;
  const [hh, mm] = String(sh.start_time).split(':').map(Number);
  // Build date in WIB timezone (UTC+7) and convert to UTC ms
  const wibMidnightUtcMs = new Date(dateStr + 'T00:00:00Z').getTime() - 7 * 3600000;
  const shiftStartUtcMs = wibMidnightUtcMs + (hh * 60 + mm) * 60000;
  return new Date(shiftStartUtcMs - (offsetMin || 0) * 60000);
}

// Hitung kapan shift berakhir di UTC, anchored ke tanggal attendance.
// Cross-midnight: kalau end <= start, end bertambah 1 hari.
function getShiftEndUtc(tenantId, departmentId, shiftName, dateStr) {
  const sh = getEffectiveShiftTime(tenantId, departmentId, shiftName);
  if (!sh.start_time || !sh.end_time) return null;
  const [sh2, sm2] = String(sh.start_time).split(':').map(Number);
  const [eh, em] = String(sh.end_time).split(':').map(Number);
  const wibMidnightUtcMs = new Date(dateStr + 'T00:00:00Z').getTime() - 7 * 3600000;
  const startMin = sh2 * 60 + sm2;
  let endMin = eh * 60 + em;
  if (endMin <= startMin) endMin += 24 * 60;
  return new Date(wibMidnightUtcMs + endMin * 60000);
}

// Cari attendance row terbuka (clock_out IS NULL) untuk staff —
// cek hari ini, kalau tidak ada cek kemarin (untuk shift yang menyeberang midnight).
function findOpenAttendance(staffId, today) {
  let row = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ? AND clock_out IS NULL').get(staffId, today);
  if (row) return row;
  const yesterday = previousDate(today);
  row = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ? AND clock_out IS NULL').get(staffId, yesterday);
  return row || null;
}

// ============ TELEGRAM MINI APP ============
function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '').trim();
}

function isIpAllowed(tenantId, ip) {
  const wl = getTenantSetting(tenantId, 'ip_whitelist', {}) || {};
  const prefixes = (wl.prefixes || []).map((p) => String(p || '').trim()).filter(Boolean);
  if (!prefixes.length) return true; // whitelist kosong = fitur mati, semua IP dibolehkan
  const norm = normalizeIp(ip);
  return prefixes.some((p) => norm.startsWith(p));
}

function getClientIp(req) {
  return normalizeIp(req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip || '');
}

function tgAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return fail(res, 401, 'Missing token');
  try {
    const payload = jwt.verify(tok, JWT_SECRET);
    if (payload.kind !== 'tg') return fail(res, 401, 'Wrong token kind');
    req.staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(payload.staff_id);
    if (!req.staff || !req.staff.is_active) return fail(res, 403, 'Staff inactive');
    next();
  } catch {
    return fail(res, 401, 'Invalid token');
  }
}

app.post('/api/bot/auth/telegram', (req, res) => {
  const { initData } = req.body || {};
  const result = verifyInitData(initData);
  if (!result) return fail(res, 401, 'Invalid initData');
  const { user, tenantId } = result;
  const staff = db.prepare('SELECT * FROM staff WHERE tenant_id = ? AND telegram_id = ?').get(tenantId, String(user.id));
  if (!staff) return fail(res, 404, 'Staff not registered. Use /start in bot first.');
  if (!staff.is_approved) return fail(res, 403, 'Akun menunggu persetujuan admin.');
  if (!staff.is_active) return fail(res, 403, 'Akun nonaktif.');
  const token = jwt.sign({ kind: 'tg', staff_id: staff.id, tenant_id: tenantId }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, staff: { id: staff.id, name: staff.name, department: staff.department, current_shift: staff.current_shift } });
});

app.get('/api/bot/me', tgAuth, (req, res) => {
  const today = todayPP();
  let att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  // Cross-midnight: kalau hari ini belum punya attendance, cek shift kemarin yg masih open.
  // Staff yang start Night kemarin 22:00 harus tetap kelihatan "Working" sampai End.
  if (!att) {
    att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ? AND clock_out IS NULL').get(req.staff.id, previousDate(today));
  }
  const sched = db.prepare('SELECT status, shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, today);

  // Break quota usage hari ini per type (include break aktif sebagai elapsed)
  // Effective quota = dept override → tenant default
  const tenantQuotas = db.prepare('SELECT type, daily_quota_minutes FROM break_settings WHERE tenant_id = ?').all(req.staff.tenant_id);
  const quotas = tenantQuotas.map((q) => ({
    type: q.type,
    daily_quota_minutes: getEffectiveBreakLimit(req.staff.tenant_id, req.staff.department_id, q.type),
  }));
  const used = db.prepare(`
    SELECT type, COALESCE(SUM(
      CASE WHEN end_time IS NOT NULL THEN duration_minutes
      ELSE CAST((julianday('now') - julianday(start_time)) * 1440 AS INTEGER)
      END
    ), 0) AS used
    FROM break_log
    WHERE staff_id = ? AND DATE(start_time) = ?
    GROUP BY type
  `).all(req.staff.id, today);
  const usedMap = {};
  used.forEach((r) => { usedMap[r.type] = r.used || 0; });
  // SHARED CUMULATIVE QUOTA: total = sum semua per-type. Overbreak satu type
  // kurangi remaining type lain via budget bersama.
  const totalQuota = quotas.reduce((a, q) => a + (q.daily_quota_minutes || 0), 0);
  const totalUsed = Object.values(usedMap).reduce((a, v) => a + v, 0);
  const totalRemaining = Math.max(0, totalQuota - totalUsed);
  const breakQuotas = {};
  quotas.forEach((q) => {
    const u = usedMap[q.type] || 0;
    const perTypeRem = Math.max(0, q.daily_quota_minutes - u);
    // Effective remaining = min(per-type remaining, total budget remaining)
    const effectiveRem = Math.min(perTypeRem, totalRemaining);
    breakQuotas[q.type] = {
      limit: q.daily_quota_minutes,
      used: u,
      remaining: effectiveRem,
      per_type_remaining: perTypeRem,
    };
  });
  const totalBudget = { total_quota: totalQuota, total_used: totalUsed, total_remaining: totalRemaining };

  const clientIp = getClientIp(req);
  const ipAllowed = isIpAllowed(req.staff.tenant_id, clientIp);

  const mq = getTenantSetting(req.staff.tenant_id, 'motivation_quotes', null) || {};
  const motivationQuotes = {
    start: (Array.isArray(mq.start) ? mq.start : []).map((s) => String(s).trim()).filter(Boolean),
    end: (Array.isArray(mq.end) ? mq.end : []).map((s) => String(s).trim()).filter(Boolean),
  };

  // Today's effective shift: HANYA dipakai kalau status work.
  // Untuk OFF/SICK/LEAVE, shift di schedule_daily cuma placeholder ('morning')
  // — jangan ditampilkan sebagai shift. Fallback ke current_shift utk display.
  // Kalau att aktif dari kemarin (cross-midnight), prioritaskan shift dari att.
  const hasActiveYesterdayAtt = att && att.date !== today && !att.clock_out;
  const isWorkDay = hasActiveYesterdayAtt || !sched || sched.status === 'work';
  const todayShift = hasActiveYesterdayAtt
    ? att.shift
    : (isWorkDay ? (sched?.shift || req.staff.current_shift) : req.staff.current_shift);
  const todayStatus = hasActiveYesterdayAtt ? 'work' : (sched?.status || 'work');

  const swapModes = getTenantSetting(req.staff.tenant_id, 'swap_modes_enabled', null) || { sick: true, move_off: true, trade: true };
  const leaveCfg = getLeaveConfig(req.staff.tenant_id);
  const leaveQuota = getLeaveQuota(req.staff.tenant_id, req.staff.id, leaveCfg);

  // Clock-in window info untuk Mini App
  const offsetMin = +(getTenantSetting(req.staff.tenant_id, 'clock_in_open_offset_minutes', 60));
  const lateCutoffMin = +(getTenantSetting(req.staff.tenant_id, 'clock_in_late_cutoff_minutes', 240));
  const openAt = computeClockInOpenTime(req.staff.tenant_id, req.staff.department_id, todayShift, today, offsetMin);
  const cutoffAt = computeClockInOpenTime(req.staff.tenant_id, req.staff.department_id, todayShift, today, -lateCutoffMin);
  const yesterdayOpen = db.prepare('SELECT shift FROM attendance WHERE staff_id = ? AND date = ? AND clock_out IS NULL').get(req.staff.id, previousDate(today));
  const nowMs = Date.now();
  const isExpired = cutoffAt ? nowMs > cutoffAt.getTime() : false;
  const isOpenNow = openAt ? (nowMs >= openAt.getTime() && !isExpired) : true;
  const clockInWindow = {
    opens_at: openAt ? openAt.toISOString() : null,
    cutoff_at: cutoffAt ? cutoffAt.toISOString() : null,
    is_open_now: isOpenNow,
    is_expired: isExpired,
    offset_minutes: offsetMin,
    late_cutoff_minutes: lateCutoffMin,
    yesterday_open_shift: yesterdayOpen?.shift || null,
  };

  res.json({
    success: true,
    staff: {
      id: req.staff.id,
      name: req.staff.name,
      department: req.staff.department,
      current_shift: req.staff.current_shift,
      today_shift: todayShift,
      today_status: todayStatus,
      is_work_day: isWorkDay,
    },
    attendance: att || null,
    schedule: sched || null,
    break_quotas: breakQuotas,
    ip_allowed: ipAllowed,
    client_ip: clientIp,
    motivation_quotes: motivationQuotes,
    swap_modes_enabled: swapModes,
    clock_in_window: clockInWindow,
    total_break_budget: totalBudget,
    leave_quota: leaveQuota,
  });
});

// Helper: validate dynamic QR session
function consumeQrSession(tenantId, staffId, action, qrToken) {
  if (!qrToken) return { error: 'QR token kosong' };
  const clean = String(qrToken).replace(/^WMS-/, '');
  const session = db.prepare(`
    SELECT * FROM qr_sessions
    WHERE qr_token = ? AND tenant_id = ? AND action = ? AND used_at IS NULL
  `).get(clean, tenantId, action);
  if (!session) return { error: 'QR tidak valid. Klik tombol untuk request QR baru.' };
  if (session.staff_id !== staffId) return { error: 'QR ini bukan untuk Anda. Request QR Anda sendiri.' };
  if (new Date(session.expires_at) < new Date()) return { error: 'QR sudah expired (5 menit). Klik tombol lagi untuk QR baru.' };
  db.prepare('UPDATE qr_sessions SET used_at = ? WHERE id = ?').run(new Date().toISOString(), session.id);
  return { session };
}

// Generate fresh QR + push ke monitor group
async function createClockQrSession(tenantId, staff, action) {
  const qrToken = crypto.randomBytes(8).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
  const r = db.prepare('INSERT INTO qr_sessions(tenant_id,staff_id,action,qr_token,expires_at) VALUES(?,?,?,?,?)')
    .run(tenantId, staff.id, action, qrToken, expiresAt);
  return { id: r.lastInsertRowid, qr_token: qrToken, expires_at: expiresAt };
}

// Staff-side: list rekan kerja di dept yang sama (untuk dropdown trade)
app.get('/api/bot/colleagues', tgAuth, (req, res) => {
  if (!req.staff.department_id) return ok(res, []);
  const rows = db.prepare(`
    SELECT id, name FROM staff
    WHERE tenant_id = ? AND id != ? AND is_active = 1 AND is_approved = 1 AND department_id = ?
    ORDER BY name
  `).all(req.staff.tenant_id, req.staff.id, req.staff.department_id);
  ok(res, rows);
});

// Lookup partner's shift on a date (untuk preview saat trade)
app.get('/api/bot/colleagues/:id/shift/:date', tgAuth, (req, res) => {
  const partnerId = +req.params.id;
  const partner = db.prepare('SELECT id FROM staff WHERE id = ? AND tenant_id = ? AND department_id = ?').get(partnerId, req.staff.tenant_id, req.staff.department_id);
  if (!partner) return fail(res, 404, 'Bukan rekan kerja Anda');
  const sd = db.prepare('SELECT shift, status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(partnerId, req.params.date);
  ok(res, sd || null);
});

app.post('/api/bot/swap-request', tgAuth, (req, res) => {
  const { swap_type, target_date, reason, target_staff_id, partner_date } = req.body || {};
  const type = ['trade', 'move_off', 'sick'].includes(swap_type) ? swap_type : null;
  if (!type) return fail(res, 400, 'swap_type harus salah satu: trade, move_off, sick');
  // Cek apakah mode ini aktif di tenant settings
  const modes = getTenantSetting(req.staff.tenant_id, 'swap_modes_enabled', null) || { sick: true, move_off: true, trade: true };
  if (modes[type] === false) {
    const labels = { sick: 'Izin Sakit', move_off: 'Tukar Off Day', trade: 'Trade Shift' };
    return fail(res, 403, `Fitur ${labels[type]} sedang dinonaktifkan oleh admin.`);
  }
  if (!target_date) return fail(res, 400, 'Tanggal diperlukan');

  const targetSched = db.prepare('SELECT shift, status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, target_date);
  let partner = null;
  let pDate = null;
  let currentShift = targetSched?.shift || req.staff.current_shift;

  if (type === 'trade') {
    if (!targetSched) return fail(res, 400, `Anda tidak punya jadwal di ${target_date}`);
    if (['off', 'sick', 'leave'].includes(targetSched.status)) return fail(res, 400, `Jadwal Anda di ${target_date} sudah ${targetSched.status.toUpperCase()}`);
    if (!target_staff_id) return fail(res, 400, 'Partner diperlukan untuk trade');
    partner = db.prepare('SELECT * FROM staff WHERE id = ? AND tenant_id = ? AND is_active = 1 AND is_approved = 1').get(+target_staff_id, req.staff.tenant_id);
    if (!partner) return fail(res, 400, 'Partner tidak ditemukan / tidak aktif');
    if (partner.id === req.staff.id) return fail(res, 400, 'Tidak bisa swap dengan diri sendiri');
    pDate = partner_date || target_date;
    const partnerSched = db.prepare('SELECT shift, status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(partner.id, pDate);
    if (!partnerSched) return fail(res, 400, `Partner tidak punya jadwal di ${pDate}`);
    if (['off', 'sick', 'leave'].includes(partnerSched.status)) return fail(res, 400, `Partner sudah ${partnerSched.status.toUpperCase()} di ${pDate}`);
  } else if (type === 'move_off') {
    // target_date = tanggal off asli (yang mau dipindah)
    // partner_date = tanggal baru yang diinginkan jadi off
    if (!targetSched) return fail(res, 400, `Anda tidak punya jadwal di ${target_date}`);
    if (targetSched.status !== 'off') return fail(res, 400, `Tanggal ${target_date} bukan jadwal OFF Anda. Pilih hari off Anda yang ingin dipindah.`);
    if (!partner_date) return fail(res, 400, 'Tanggal baru diperlukan (hari yang diinginkan jadi off)');
    if (partner_date === target_date) return fail(res, 400, 'Tanggal baru harus beda dari tanggal off asli');
    const newSched = db.prepare('SELECT status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, partner_date);
    if (!newSched) return fail(res, 400, `Anda tidak punya jadwal di ${partner_date}`);
    if (newSched.status !== 'work') return fail(res, 400, `Tanggal ${partner_date} bukan jadwal kerja (${newSched.status}). Tidak bisa dipindah jadi off.`);
    pDate = partner_date;
  } else if (type === 'sick') {
    if (!reason || !reason.trim()) return fail(res, 400, 'Alasan sakit diperlukan');
    // Boleh untuk tanggal apapun (scheduled work) — tidak bisa double sick kalau sudah sick/leave/off
    if (targetSched && ['sick', 'leave', 'off'].includes(targetSched.status)) {
      return fail(res, 400, `Jadwal ${target_date} sudah ${targetSched.status.toUpperCase()}`);
    }
  }

  const r = db.prepare(`INSERT INTO swap_requests(tenant_id,requester_id,target_date,current_shift,reason,status,target_staff_id,partner_date,swap_type)
                        VALUES(?,?,?,?,?,'pending',?,?,?)`)
    .run(req.staff.tenant_id, req.staff.id, target_date, currentShift, reason || '', target_staff_id || null, pDate, type);
  const swapId = r.lastInsertRowid;

  notifySwapRequest(req.staff.tenant_id, req.staff, partner, target_date, pDate, currentShift, reason, swapId, type).catch((e) => console.warn('[bot] notifySwapRequest:', e.message));
  emitLiveUpdate(req.staff.tenant_id, 'swap_request', { swap_id: swapId });
  ok(res, { id: swapId, type });
});

app.get('/api/bot/leave-quota', tgAuth, (req, res) => {
  ok(res, getLeaveQuota(req.staff.tenant_id, req.staff.id));
});

app.post('/api/bot/leave-request', tgAuth, (req, res) => {
  const cfg = getLeaveConfig(req.staff.tenant_id);
  if (!cfg.enabled) return fail(res, 403, 'Fitur cuti sedang dinonaktifkan oleh admin.');
  const { start_date, end_date, reason } = req.body || {};
  if (!start_date || !end_date) return fail(res, 400, 'Tanggal mulai & selesai wajib diisi.');
  if (!reason || !reason.trim()) return fail(res, 400, 'Alasan cuti wajib diisi.');
  if (end_date < start_date) return fail(res, 400, 'Tanggal selesai tidak boleh sebelum tanggal mulai.');
  const today = new Date().toISOString().slice(0, 10);
  if (start_date < today) return fail(res, 400, 'Tanggal mulai tidak boleh masa lalu.');

  const days = diffDaysInclusive(start_date, end_date);
  if (days <= 0) return fail(res, 400, 'Rentang tanggal tidak valid.');
  if (days > cfg.days_per_period) return fail(res, 400, `Maksimal ${cfg.days_per_period} hari per pengajuan.`);

  // Both endpoints harus dalam period yang sama
  const periodStart = getPeriodKeyForDate(start_date, cfg.period_months);
  const periodEnd = getPeriodKeyForDate(end_date, cfg.period_months);
  if (periodStart !== periodEnd) {
    return fail(res, 400, 'Cuti tidak boleh melintasi 2 period (bagi jadi 2 pengajuan terpisah).');
  }

  // Cek kuota
  const quotaSnapshot = getLeaveQuota(req.staff.tenant_id, req.staff.id, cfg);
  if (quotaSnapshot.period_key !== periodStart) {
    // pengajuan untuk period berbeda dari today — hitung ulang untuk period itu
    const rows = db.prepare(`SELECT status, days FROM leave_requests
                             WHERE tenant_id = ? AND staff_id = ? AND period_key = ? AND status IN ('pending','approved')`)
      .all(req.staff.tenant_id, req.staff.id, periodStart);
    let used = 0; for (const r of rows) used += r.days;
    if (used + days > cfg.days_per_period) {
      return fail(res, 400, `Kuota period ${periodStart} tidak cukup. Tersisa ${cfg.days_per_period - used} hari.`);
    }
  } else if (quotaSnapshot.remaining < days) {
    return fail(res, 400, `Sisa kuota cuti hanya ${quotaSnapshot.remaining} hari (period ${quotaSnapshot.period_key}).`);
  }

  // Cek konflik dengan jadwal: tidak boleh ada hari yang sudah sick/leave
  const conflict = db.prepare(`SELECT date, status FROM schedule_daily
                               WHERE staff_id = ? AND date BETWEEN ? AND ? AND status IN ('sick','leave')`)
    .get(req.staff.id, start_date, end_date);
  if (conflict) return fail(res, 400, `Tanggal ${conflict.date} sudah berstatus ${conflict.status.toUpperCase()}.`);

  const r = db.prepare(`INSERT INTO leave_requests(tenant_id,staff_id,start_date,end_date,days,reason,period_key,status)
                        VALUES(?,?,?,?,?,?,?, 'pending')`)
    .run(req.staff.tenant_id, req.staff.id, start_date, end_date, days, reason.trim(), periodStart);
  const leaveId = r.lastInsertRowid;

  notifyLeaveRequest(req.staff.tenant_id, req.staff, { start_date, end_date, days, reason: reason.trim(), period_key: periodStart, leave_id: leaveId })
    .catch((e) => console.warn('[bot] notifyLeaveRequest:', e.message));
  emitLiveUpdate(req.staff.tenant_id, 'leave_request', { leave_id: leaveId });
  ok(res, { id: leaveId, days, period_key: periodStart });
});

app.post('/api/bot/clock-in-request-qr', tgAuth, async (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_in', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor untuk Start Kerja.`);
  }
  // Pre-validate prerequisites
  const today = todayPP();
  const existing = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (existing) return fail(res, 400, 'Sudah clock-in hari ini.');
  // Cek shift kemarin yang belum di-clock-out (mis. night shift cross midnight)
  const yesterdayOpen = db.prepare('SELECT shift FROM attendance WHERE staff_id = ? AND date = ? AND clock_out IS NULL').get(req.staff.id, previousDate(today));
  if (yesterdayOpen) {
    return fail(res, 400, `Shift ${yesterdayOpen.shift} kemarin belum di-clock-out. Pulang Kerja dulu.`);
  }
  const sched = db.prepare('SELECT status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (sched && ['off', 'sick', 'leave'].includes(sched.status)) {
    return fail(res, 400, `Jadwal hari ini: ${sched.status.toUpperCase()}. Tidak bisa clock-in.`);
  }
  // Validasi window: tidak bisa start kepagian (sebelum shift_start - early_offset)
  // dan tidak bisa start kemalaman (lewat shift_start + late_cutoff)
  const offsetMin = +(getTenantSetting(req.staff.tenant_id, 'clock_in_open_offset_minutes', 60));
  const lateCutoffMin = +(getTenantSetting(req.staff.tenant_id, 'clock_in_late_cutoff_minutes', 240));
  const todayShift = sched?.shift || req.staff.current_shift;
  const openAt = computeClockInOpenTime(req.staff.tenant_id, req.staff.department_id, todayShift, today, offsetMin);
  if (openAt && Date.now() < openAt.getTime()) {
    const wibOpen = new Date(openAt.getTime() + 7 * 3600000).toISOString().slice(11, 16);
    return fail(res, 400, `Tombol Mulai akan aktif jam ${wibOpen} WIB (shift ${todayShift}).`);
  }
  // Cek upper bound: shift_start + late_cutoff
  const cutoffAt = computeClockInOpenTime(req.staff.tenant_id, req.staff.department_id, todayShift, today, -lateCutoffMin);
  if (cutoffAt && Date.now() > cutoffAt.getTime()) {
    const wibCutoff = new Date(cutoffAt.getTime() + 7 * 3600000).toISOString().slice(11, 16);
    return fail(res, 400, `Shift ${todayShift} sudah lewat ${Math.floor(lateCutoffMin / 60)}j ${lateCutoffMin % 60}m (cutoff ${wibCutoff} WIB). Hubungi admin untuk attendance manual.`);
  }
  const session = await createClockQrSession(req.staff.tenant_id, req.staff, 'clock_in');
  pushClockQRToMonitor(req.staff.tenant_id, { ...session, action: 'clock_in' }, req.staff).catch((e) => console.warn('[bot] push QR failed:', e.message));
  ok(res, session);
});

app.post('/api/bot/clock-out-request-qr', tgAuth, async (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_out', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor untuk Pulang Kerja.`);
  }
  const today = todayPP();
  const att = findOpenAttendance(req.staff.id, today);
  if (!att) return fail(res, 400, 'Tidak ada shift terbuka untuk di-clock-out.');
  const session = await createClockQrSession(req.staff.tenant_id, req.staff, 'clock_out');
  pushClockQRToMonitor(req.staff.tenant_id, { ...session, action: 'clock_out' }, req.staff).catch((e) => console.warn('[bot] push QR failed:', e.message));
  ok(res, session);
});

app.post('/api/bot/clock-in-qr', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_in', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Clock-In.`);
  }
  const r = consumeQrSession(req.staff.tenant_id, req.staff.id, 'clock_in', req.body?.qr_token);
  if (r.error) return fail(res, 400, r.error);
  return clockInImpl(req, res);
});

app.post('/api/bot/clock-out-qr', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_out', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Clock-Out.`);
  }
  const r = consumeQrSession(req.staff.tenant_id, req.staff.id, 'clock_out', req.body?.qr_token);
  if (r.error) return fail(res, 400, r.error);
  return clockOutImpl(req, res);
});

app.post('/api/bot/clock-in', tgAuth, (req, res) => clockInImpl(req, res));

function clockInImpl(req, res) {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_in', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Clock-In.`);
  }
  const today = todayPP();
  const existing = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (existing) return fail(res, 400, 'Sudah clock-in hari ini.');

  // Prefer shift dari schedule_daily hari ini; fallback ke staff.current_shift
  const sched = db.prepare('SELECT shift, status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (sched && ['off', 'sick', 'leave'].includes(sched.status)) {
    return fail(res, 400, `Jadwal hari ini: ${sched.status.toUpperCase()}. Tidak bisa clock-in.`);
  }
  const effectiveShift = sched?.shift || req.staff.current_shift;

  const now = new Date();
  const shiftRow = getEffectiveShiftTime(req.staff.tenant_id, req.staff.department_id, effectiveShift);
  const grace = +(getTenantSetting(req.staff.tenant_id, 'late_grace_minutes', 5));
  // Hitung actual lateness (apa adanya) — selalu disimpan apa adanya untuk akurasi
  let actualLate = 0;
  if (shiftRow?.start_time) {
    const [h, m] = shiftRow.start_time.split(':').map(Number);
    const shiftStart = new Date(now); shiftStart.setHours(h, m, 0, 0);
    const diff = Math.round((now - shiftStart) / 60000);
    if (diff > 0) actualLate = diff;
  }
  db.prepare('INSERT INTO attendance(tenant_id,staff_id,date,shift,clock_in,late_minutes,ip_address,current_status) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.staff.tenant_id, req.staff.id, today, effectiveShift, now.toISOString(), actualLate, clientIp.slice(0, 45), 'working');
  // Notif kirim untuk SETIAP keterlambatan (>= 1 menit) — kepala dept harus tahu
  // Grace cuma melindungi skor produktivitas, bukan menghilangkan notif
  if (actualLate >= 1) {
    const withinGrace = actualLate <= grace;
    notifyLate(
      req.staff.tenant_id,
      { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id },
      actualLate,
      effectiveShift,
      withinGrace,
    ).catch((e) => console.warn('[bot] notifyLate:', e.message));
  }
  emitLiveUpdate(req.staff.tenant_id, 'clock_in', { staff_id: req.staff.id });
  ok(res, { clock_in: now.toISOString(), late_minutes: lateMin });
}

app.post('/api/bot/clock-out', tgAuth, (req, res) => clockOutImpl(req, res));

function clockOutImpl(req, res) {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'clock_out', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Clock-Out.`);
  }
  const today = todayPP();
  const att = findOpenAttendance(req.staff.id, today);
  if (!att) return fail(res, 400, 'Tidak ada shift terbuka untuk di-clock-out.');
  const now = new Date();
  const totalMin = Math.round((now - new Date(att.clock_in)) / 60000);
  const breakMin = att.total_break_minutes || 0;
  const workMin = Math.max(0, totalMin - breakMin);

  // === Formula Productivity (cumulative berdasar baseline shift) ===
  // Grace minutes melindungi skor: kalau telat dalam grace, tidak dikurangi dari score.
  const expectedWork = computeExpectedWorkMinutes(req.staff.tenant_id, req.staff.department_id, att.shift);
  const breakQuota = getTotalBreakQuota(req.staff.tenant_id, req.staff.department_id);
  const overbreakMin = Math.max(0, breakMin - breakQuota);
  const grace = +(getTenantSetting(req.staff.tenant_id, 'late_grace_minutes', 5));
  const latePenalty = Math.max(0, (att.late_minutes || 0) - grace);
  const { score: productiveScore, ratio: productive } = calculateProductiveRatio(expectedWork, latePenalty, overbreakMin);

  db.prepare(`UPDATE attendance SET clock_out = ?, current_status = ?,
              total_work_minutes = ?, productive_ratio = ?,
              expected_work_minutes = ?, productive_score = ?, overbreak_minutes = ?
              WHERE id = ?`)
    .run(now.toISOString(), 'offline', workMin, productive, expectedWork, productiveScore, overbreakMin, att.id);
  emitLiveUpdate(req.staff.tenant_id, 'clock_out', { staff_id: req.staff.id });
  ok(res, {
    clock_out: now.toISOString(),
    total_work_minutes: workMin,
    productive_ratio: productive,
    expected_work_minutes: expectedWork,
    productive_score: productiveScore,
    overbreak_minutes: overbreakMin,
  });
}

app.post('/api/bot/break-start', tgAuth, async (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'break_start', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk mulai break.`);
  }
  const { type } = req.body || {};
  if (!['smoke', 'toilet', 'outside'].includes(type)) return fail(res, 400, 'Invalid break type');
  const today = todayPP();
  // Cross-midnight: cek shift hari ini DULU, fallback ke shift kemarin yg masih open
  const att = findOpenAttendance(req.staff.id, today);
  if (!att) return fail(res, 400, 'Belum clock-in atau sudah clock-out.');
  if (att.current_status !== 'working') return fail(res, 400, 'Sedang break, end dulu.');
  const dailyQuota = getEffectiveBreakLimit(req.staff.tenant_id, req.staff.department_id, type);

  // SHARED CUMULATIVE QUOTA: total budget = sum semua per-type quota.
  // Overbreak satu type kurangi sisa type lain (waterfall).
  const allTypes = ['smoke', 'toilet', 'outside'];
  const totalQuota = allTypes.reduce((a, t) => a + (getEffectiveBreakLimit(req.staff.tenant_id, req.staff.department_id, t) || 0), 0);
  const totalUsedRow = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS used
    FROM break_log
    WHERE staff_id = ? AND DATE(start_time) = ?
  `).get(req.staff.id, today);
  const totalUsed = totalUsedRow?.used || 0;
  const totalRemaining = Math.max(0, totalQuota - totalUsed);

  if (totalRemaining <= 0) {
    return fail(res, 400, `Total kuota break habis hari ini (${totalUsed}m / ${totalQuota}m). Tidak bisa break apapun lagi.`);
  }

  // Per-type used
  const used = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS used
    FROM break_log
    WHERE staff_id = ? AND type = ? AND DATE(start_time) = ? AND end_time IS NOT NULL
  `).get(req.staff.id, type, today).used || 0;

  if (used >= dailyQuota) {
    const labels = { smoke: 'Smoke', toilet: 'Toilet', outside: 'Go Out' };
    return fail(res, 400, `Kuota ${labels[type] || type} habis hari ini (${used}m/${dailyQuota}m). Sisa total budget: ${totalRemaining}m — coba type lain.`);
  }

  // Limit untuk break ini = min(sisa per-type, sisa total budget)
  // — supaya overbreak satu type kurangi remaining type lain
  const perTypeRemaining = Math.max(1, dailyQuota - used);
  const remainingQuota = Math.min(perTypeRemaining, totalRemaining);

  const now = new Date();
  const ipStart = clientIp.slice(0, 45);
  // limit_minutes di break_log = sisa kuota harian (bukan kuota penuh) supaya
  // SISA WAKTU di Mini App dan progress bar reflect remaining daily quota
  const r = db.prepare('INSERT INTO break_log(tenant_id,attendance_id,staff_id,type,start_time,limit_minutes,ip_address_start) VALUES(?,?,?,?,?,?,?)')
    .run(req.staff.tenant_id, att.id, req.staff.id, type, now.toISOString(), remainingQuota, ipStart);
  const statusMap = { smoke: 'smoking', toilet: 'toilet', outside: 'outside' };
  db.prepare('UPDATE attendance SET current_status = ?, break_start = ?, break_type = ?, break_limit = ? WHERE id = ?')
    .run(statusMap[type], now.toISOString(), type, remainingQuota, att.id);
  emitLiveUpdate(req.staff.tenant_id, 'break_start', { staff_id: req.staff.id, type });
  ok(res, { break_id: r.lastInsertRowid, limit_minutes: remainingQuota, daily_quota: dailyQuota, used_before: used });
});

app.post('/api/bot/break-request-qr', tgAuth, async (req, res) => {
  // Cek IP DULU sebelum push QR ke grup — supaya QR tidak terkirim kalau di luar kantor
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'break_end', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Tidak bisa request QR Back to Work.`);
  }
  const today = todayPP();
  const att = findOpenAttendance(req.staff.id, today);
  if (!att) return fail(res, 400, 'Belum clock-in atau sudah clock-out.');
  const bl = db.prepare('SELECT * FROM break_log WHERE staff_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1').get(req.staff.id);
  if (!bl) return fail(res, 400, 'Tidak ada break aktif.');
  // Generate QR token baru (regenerate setiap request supaya QR lama invalid)
  const qrToken = crypto.randomBytes(8).toString('hex');
  const qrExp = new Date(Date.now() + 5 * 60000).toISOString(); // valid 5 menit
  db.prepare('UPDATE break_log SET qr_token = ?, qr_expires_at = ? WHERE id = ?').run(qrToken, qrExp, bl.id);
  const updatedBl = { id: bl.id, type: bl.type, qr_token: qrToken };
  pushBreakQRToMonitor(req.staff.tenant_id, updatedBl, req.staff).catch((e) => console.warn('[bot] push QR failed:', e.message));
  ok(res, { break_id: bl.id, qr_token: qrToken, qr_expires_at: qrExp });
});

app.post('/api/bot/break-end-qr', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'break_end', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Back to Work.`);
  }
  const { break_id, qr_token } = req.body || {};
  if (!break_id || !qr_token) return fail(res, 400, 'break_id and qr_token required');
  const bl = db.prepare('SELECT * FROM break_log WHERE id = ?').get(+break_id);
  if (!bl) return fail(res, 404, 'QR tidak ditemukan');
  if (bl.qr_token !== qr_token) return fail(res, 400, 'QR token tidak cocok');
  if (bl.staff_id !== req.staff.id) return fail(res, 403, 'QR ini bukan untuk Anda');
  if (bl.end_time) return fail(res, 400, 'Break sudah selesai');
  if (bl.qr_expires_at && new Date(bl.qr_expires_at) < new Date()) return fail(res, 400, 'QR expired');
  const now = new Date();
  const dur = Math.round((now - new Date(bl.start_time)) / 60000);
  const overtime = dur > (bl.limit_minutes || 9999) ? 1 : 0;
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = ?, is_overtime = ?, ip_address_end = ? WHERE id = ?').run(now.toISOString(), dur, overtime, clientIp.slice(0, 45), bl.id);
  // Update attendance via FK attendance_id, bukan date — supaya cross-midnight ikut benar
  db.prepare(`UPDATE attendance SET current_status = ?, break_start = NULL, break_type = NULL, break_limit = NULL,
              total_break_minutes = COALESCE(total_break_minutes,0) + ?, break_violations = COALESCE(break_violations,0) + ?
              WHERE id = ?`)
    .run('working', dur, overtime, bl.attendance_id);
  if (overtime) {
    notifyOvertime(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, bl.type, dur, bl.limit_minutes).catch((e) => console.warn('[bot] notifyOvertime:', e.message));
  }
  emitLiveUpdate(req.staff.tenant_id, 'break_end', { staff_id: req.staff.id });
  ok(res, { duration_minutes: dur, is_overtime: !!overtime });
});

app.post('/api/bot/break-end', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    notifyIpViolation(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department, department_id: req.staff.department_id }, 'break_end', clientIp).catch(() => {});
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Back to Work.`);
  }
  const bl = db.prepare('SELECT * FROM break_log WHERE staff_id = ? AND end_time IS NULL ORDER BY id DESC LIMIT 1').get(req.staff.id);
  if (!bl) return fail(res, 400, 'Tidak ada break aktif.');
  const qrRequired = !!getTenantSetting(req.staff.tenant_id, 'qr_required', false);
  if (qrRequired) return fail(res, 400, 'QR scan required. Scan QR dari grup monitor.');
  const now = new Date();
  const dur = Math.round((now - new Date(bl.start_time)) / 60000);
  const overtime = dur > (bl.limit_minutes || 9999) ? 1 : 0;
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = ?, is_overtime = ?, ip_address_end = ? WHERE id = ?').run(now.toISOString(), dur, overtime, clientIp.slice(0, 45), bl.id);
  db.prepare(`UPDATE attendance SET current_status = ?, break_start = NULL, break_type = NULL, break_limit = NULL,
              total_break_minutes = COALESCE(total_break_minutes,0) + ?, break_violations = COALESCE(break_violations,0) + ?
              WHERE id = ?`)
    .run('working', dur, overtime, bl.attendance_id);
  emitLiveUpdate(req.staff.tenant_id, 'break_end_manual', { staff_id: req.staff.id });
  ok(res, { duration_minutes: dur, is_overtime: !!overtime });
});

// ============ SERVE FRONTEND (production) ============
const distDir = path.resolve(__dirname, '../dashboard/dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
  console.log(`[backend] serving frontend from ${distDir}`);
}

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message });
});

function ensureAdminUser() {
  const defaultTid = getDefaultTenantId();
  // Super admin: can see all tenants
  const superExists = db.prepare('SELECT id FROM users WHERE username = ?').get('superadmin');
  if (!superExists) {
    const pwd = process.env.SUPERADMIN_INITIAL_PASSWORD || 'super123';
    const hash = bcrypt.hashSync(pwd, 8);
    db.prepare('INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,?,?,?,NULL)').run('superadmin', hash, 'Super Administrator', 'super_admin');
    console.log(`[backend] super_admin created (superadmin / ${pwd}) — change password ASAP`);
  }
  // Tenant admin (PanenGroup): for backwards compat and default tenant access
  const existing = db.prepare('SELECT id, tenant_id FROM users WHERE username = ?').get('admin');
  if (!existing) {
    const pwd = process.env.ADMIN_INITIAL_PASSWORD || 'admin123';
    const hash = bcrypt.hashSync(pwd, 8);
    db.prepare('INSERT INTO users(username,password_hash,name,role,tenant_id) VALUES(?,?,?,?,?)').run('admin', hash, 'Administrator', 'admin', defaultTid);
    console.log(`[backend] admin (PanenGroup) created (admin / ${pwd}) — change password ASAP`);
  } else if (!existing.tenant_id && defaultTid) {
    db.prepare('UPDATE users SET tenant_id = ? WHERE id = ?').run(defaultTid, existing.id);
    console.log('[backend] existing admin reassigned to PanenGroup tenant');
  }
  return true;
}

app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  try {
    ensureAdminUser();
    const u = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const s = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
    const sd = db.prepare('SELECT COUNT(*) AS c FROM schedule_daily').get().c;
    const att = db.prepare('SELECT COUNT(*) AS c FROM attendance').get().c;
    console.log(`[backend] DB stats: ${u} users · ${s} staff · ${sd} schedule rows · ${att} attendance rows`);
  } catch (e) { console.warn('[backend] stats query failed:', e.message); }
  startBot();
  startDailyBriefingScheduler();
});

// Auto-end break yang sudah lewat limit + grace (default 2 menit).
// Tutup break_log, balikkan attendance.current_status='working', kasih notif.
function autoEndOverbreaks(tenantId, graceMinutes = 2) {
  const sc = tenantId
    ? { clause: ' AND s.tenant_id = ?', params: [tenantId] }
    : { clause: '', params: [] };
  const active = db.prepare(`
    SELECT bl.id, bl.attendance_id, bl.staff_id, bl.type, bl.start_time, bl.limit_minutes,
           s.tenant_id, s.name, s.department, s.department_id, s.telegram_id,
           CAST((julianday('now') - julianday(bl.start_time)) * 1440 AS INTEGER) AS elapsed_min
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.end_time IS NULL AND bl.limit_minutes IS NOT NULL${sc.clause}
  `).all(...sc.params);

  const ended = [];
  for (const bl of active) {
    const overByMin = bl.elapsed_min - bl.limit_minutes;
    if (overByMin <= graceMinutes) continue; // belum lewat grace
    const now = new Date().toISOString();
    db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = ?, is_overtime = 1, ip_address_end = ? WHERE id = ?')
      .run(now, bl.elapsed_min, 'auto-overbreak', bl.id);
    db.prepare(`UPDATE attendance SET current_status = 'working', break_start = NULL, break_type = NULL, break_limit = NULL,
                total_break_minutes = COALESCE(total_break_minutes,0) + ?, break_violations = COALESCE(break_violations,0) + 1
                WHERE id = ?`)
      .run(bl.elapsed_min, bl.attendance_id);
    ended.push({ ...bl, duration: bl.elapsed_min, over: overByMin });
    emitLiveUpdate(bl.tenant_id, 'break_auto_end', { staff_id: bl.staff_id });
    // Notif kepala dept (overtime) + staff DM
    notifyOvertime(bl.tenant_id, { name: bl.name, department: bl.department, department_id: bl.department_id }, bl.type, bl.elapsed_min, bl.limit_minutes).catch(() => {});
    notifyBreakAutoEnded(bl.tenant_id, bl.telegram_id, bl.name, bl.type, bl.elapsed_min, bl.limit_minutes).catch(() => {});
  }
  return ended;
}

// Auto-close shift terbuka yang sudah lewat shift_end + grace.
// Set clock_out = shift_end (waktu seharusnya), mark is_auto_closed=1.
// Notify dept group dengan list staff yang ke-auto-close.
function autoCloseStaleAttendance(tenantId, graceMinutes = 240) {
  const now = Date.now();
  const sc = tenantId
    ? { clause: ' AND a.tenant_id = ?', params: [tenantId] }
    : { clause: '', params: [] };
  // Hanya cek attendance dari kemarin atau lebih lama (today shift mungkin masih jalan)
  const yesterday = previousDate(todayPP());
  const open = db.prepare(`
    SELECT a.id, a.tenant_id, a.staff_id, a.date, a.shift, a.clock_in,
           s.name, s.department, s.department_id, s.telegram_id
    FROM attendance a
    JOIN staff s ON s.id = a.staff_id
    WHERE a.clock_out IS NULL AND a.date <= ?${sc.clause}
  `).all(yesterday, ...sc.params);

  const closed = []; // { tenantId, staff_id, name, department_id, ... }
  for (const a of open) {
    const shiftEnd = getShiftEndUtc(a.tenant_id, a.department_id || null, a.shift, a.date);
    const fallbackEnd = new Date(a.date + 'T22:00:00Z').getTime() + 12 * 3600000; // safety
    const endMs = shiftEnd ? shiftEnd.getTime() : fallbackEnd;
    if (now < endMs + graceMinutes * 60000) continue; // belum lewat grace
    const closeAt = new Date(endMs).toISOString();
    const totalMin = Math.round((endMs - new Date(a.clock_in).getTime()) / 60000);
    db.prepare(`UPDATE attendance SET clock_out = ?, current_status = 'offline', is_auto_closed = 1,
                total_work_minutes = COALESCE(total_work_minutes, 0) + ?
                WHERE id = ?`)
      .run(closeAt, Math.max(0, totalMin), a.id);
    // Tutup juga break_log yang masih open untuk staff ini
    db.prepare("UPDATE break_log SET end_time = ?, duration_minutes = CAST((julianday(?) - julianday(start_time)) * 1440 AS INTEGER) WHERE staff_id = ? AND end_time IS NULL")
      .run(closeAt, closeAt, a.staff_id);
    closed.push(a);
  }
  return closed;
}

// Sync staff.current_shift dari schedule_daily hari ini.
// Hanya update untuk staff yang punya schedule status='work' dengan shift berbeda.
// OFF/SICK/LEAVE tidak menyentuh current_shift (preserve last work shift).
function syncStaffShiftsFromDaily(tenantId, dateStr) {
  // Diagnostic: ambil semua staff aktif + status hari ini
  const all = db.prepare(`
    SELECT s.id AS staff_id, s.name, s.current_shift, s.tenant_id,
           sd.shift AS sched_shift, sd.status AS sched_status
    FROM staff s
    LEFT JOIN schedule_daily sd ON sd.staff_id = s.id AND sd.date = ?
    WHERE s.tenant_id = ? AND s.is_active = 1
  `).all(dateStr, tenantId);

  const upd = db.prepare('UPDATE staff SET current_shift = ? WHERE id = ?');
  const findLastWork = db.prepare(`
    SELECT shift FROM schedule_daily
    WHERE staff_id = ? AND date <= ? AND status = 'work' AND shift IS NOT NULL
    ORDER BY date DESC LIMIT 1
  `);
  // Fallback: cari shift dari hari KERJA TERDEKAT (forward) — untuk staff yang belum
  // punya hari kerja sama sekali sebelum tanggal ini
  const findNextWork = db.prepare(`
    SELECT shift FROM schedule_daily
    WHERE staff_id = ? AND date > ? AND status = 'work' AND shift IS NOT NULL
    ORDER BY date ASC LIMIT 1
  `);
  const changes = [];
  const skipped = [];
  db.transaction(() => {
    for (const r of all) {
      let target = null;
      let reason = null;

      if (r.sched_status === 'work' && r.sched_shift) {
        target = r.sched_shift;
      } else {
        // Hari ini OFF/SICK/LEAVE atau belum ada jadwal:
        // Prefer NEXT upcoming work day (intent terbaru), fallback ke past
        const future = findNextWork.get(r.staff_id, dateStr);
        if (future?.shift) {
          target = future.shift;
        } else {
          const past = findLastWork.get(r.staff_id, dateStr);
          if (past?.shift) target = past.shift;
        }
        if (!r.sched_status) reason = 'no_schedule_today';
        else if (r.sched_status !== 'work') reason = r.sched_status;
        else reason = 'work_no_shift';
      }

      if (!target) {
        skipped.push({ name: r.name, reason: reason || 'no_work_shift_anywhere', current: r.current_shift });
      } else if (target === r.current_shift) {
        // already synced (mungkin hari ini OFF tapi current_shift sudah cocok dgn last work)
      } else {
        upd.run(target, r.staff_id);
        changes.push({ staff_id: r.staff_id, name: r.name, from: r.current_shift, to: target, source: reason ? `fallback_${reason}` : 'today_work' });
      }
    }
  })();
  return {
    date: dateStr,
    tenant_id: tenantId,
    total_active_staff: all.length,
    updated: changes.length,
    already_synced: all.length - changes.length - skipped.length,
    skipped_count: skipped.length,
    changes,
    skipped,
  };
}

// Manual trigger sync (admin testing)
app.post('/api/settings/sync-shifts', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const result = syncStaffShiftsFromDaily(tid, todayPP());
  ok(res, result);
});

// Manual trigger auto-close stale shifts (admin)
app.post('/api/activity/auto-close-stale', auth, (req, res) => {
  if (req.user?.role !== 'admin' && req.user?.role !== 'super_admin') return fail(res, 403, 'Admin only');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const grace = +(req.query.grace_minutes ?? 240);
  const closed = autoCloseStaleAttendance(tid, grace);
  emitLiveUpdate(tid, 'auto_close_stale', { count: closed.length });
  // Notif aggregated kalau ada
  if (closed.length > 0) {
    notifyAutoCloseSummary(tid, closed).catch(() => {});
  }
  ok(res, {
    closed_count: closed.length,
    closed: closed.map((c) => ({ staff_id: c.staff_id, name: c.name, date: c.date, shift: c.shift })),
  });
});

// Daily briefing scheduler — fires at HH:00 PP per tenant once per date.
// Juga sync staff.current_shift dari jadwal hari ini sebelum kirim briefing.
function startDailyBriefingScheduler() {
  // Jalankan sync + auto-close sekali saat startup
  try {
    const today = todayPP();
    const tenants = db.prepare('SELECT id FROM tenants').all();
    for (const t of tenants) {
      const r = syncStaffShiftsFromDaily(t.id, today);
      if (r.updated > 0) console.log(`[startup] synced ${r.updated} staff shifts for tenant=${t.id}`);
      try {
        const closed = autoCloseStaleAttendance(t.id);
        if (closed.length > 0) {
          console.log(`[startup] auto-closed ${closed.length} stale shifts for tenant=${t.id}`);
          notifyAutoCloseSummary(t.id, closed).catch(() => {});
        }
      } catch (e) { console.warn('[startup] auto-close failed:', e.message); }
    }
  } catch (e) { console.warn('[startup] shift sync failed:', e.message); }

  let lastAutoCloseHour = -1;
  setInterval(async () => {
    try {
      const ppNow = new Date(Date.now() + 7 * 3600000);
      const ppHour = ppNow.getUTCHours();
      const today = todayPP();
      const tenants = db.prepare('SELECT id FROM tenants').all();

      // Auto-close stale shifts: jalankan setiap pergantian jam (1x per jam, hemat resource)
      if (ppHour !== lastAutoCloseHour) {
        lastAutoCloseHour = ppHour;
        for (const t of tenants) {
          try {
            const closed = autoCloseStaleAttendance(t.id);
            if (closed.length > 0) {
              console.log(`[scheduler] auto-closed ${closed.length} stale shifts for tenant=${t.id}`);
              await notifyAutoCloseSummary(t.id, closed);
            }
          } catch (e) { console.warn('[scheduler] auto-close tenant', t.id, e.message); }
        }
      }

      // Auto-end overbreak: jalankan tiap menit (cepat, supaya enforcement responsif)
      for (const t of tenants) {
        try {
          const ended = autoEndOverbreaks(t.id);
          if (ended.length > 0) console.log(`[scheduler] auto-ended ${ended.length} overbreaks for tenant=${t.id}`);
        } catch (e) { console.warn('[scheduler] overbreak auto-end:', e.message); }
      }

      // Daily briefing: jalankan di jam yang ditentukan, sekali per tanggal
      for (const t of tenants) {
        const cfg = getTenantSetting(t.id, 'daily_briefing', null) || {};
        if (cfg.enabled === false) continue;
        const hour = Number.isInteger(+cfg.hour) ? +cfg.hour : 6;
        if (ppHour !== hour) continue;
        const lastSent = getTenantSetting(t.id, 'daily_briefing_last_sent', null);
        if (lastSent === today) continue;
        const sync = syncStaffShiftsFromDaily(t.id, today);
        if (sync.updated > 0) console.log(`[scheduler] synced ${sync.updated} staff shifts for tenant=${t.id}`);
        await notifyDailyOffSummary(t.id, today);
        setTenantSetting(t.id, 'daily_briefing_last_sent', today);
        console.log(`[scheduler] daily briefing sent tenant=${t.id} date=${today}`);
      }
    } catch (e) { console.warn('[scheduler] tick:', e.message); }
  }, 60_000);
  console.log('[scheduler] daily briefing + shift sync + hourly auto-close started');
}
