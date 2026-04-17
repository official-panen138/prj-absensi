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
import { startBot, reloadBot, getBotStatus, verifyInitData, notifyApproved, notifyLate, notifyOvertime, pushBreakQRToMonitor } from './bot.js';
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

app.post('/api/staff', auth, (req, res) => {
  const b = req.body || {};
  if (!b.name) return fail(res, 400, 'Name required');
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const r = db.prepare(`INSERT INTO staff(tenant_id,name,category,current_shift,department,phone,telegram_id,telegram_username,join_date,is_active,is_approved)
                        VALUES(?,?,?,?,?,?,?,?,?,1,1)`).run(tid, b.name, b.category || 'indonesian', b.current_shift || 'morning', b.department || null, b.phone || null, b.telegram_id || null, b.telegram_username || null, b.join_date || null);
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
  const allowed = ['name', 'category', 'current_shift', 'department', 'phone', 'telegram_id', 'telegram_username', 'join_date'];
  const fields = [], values = [];
  for (const k of allowed) if (k in req.body) { fields.push(`${k} = ?`); values.push(req.body[k]); }
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

app.get('/api/activity/live', auth, (req, res) => {
  const today = todayPP();
  const sc = scopeTenant(req, 's.tenant_id');
  const staff = db.prepare(`
    SELECT s.id, s.tenant_id, s.name, s.department, s.category, s.current_shift,
           a.clock_in, a.clock_out, a.late_minutes, a.current_status,
           a.break_start, a.break_limit,
           sd.status AS schedule_status
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date = ?
    LEFT JOIN schedule_daily sd ON sd.staff_id = s.id AND sd.date = ?
    WHERE s.is_active = 1${sc.clause}
    ORDER BY s.name
  `).all(today, today, ...sc.params);

  // Break quota usage per staff per type hari ini
  const bsc = scopeTenant(req, 's2.tenant_id');
  const usage = db.prepare(`
    SELECT bl.staff_id, bl.type, COALESCE(SUM(bl.duration_minutes),0) AS used
    FROM break_log bl JOIN staff s2 ON s2.id = bl.staff_id
    WHERE DATE(bl.start_time) = ? AND bl.end_time IS NOT NULL${bsc.clause}
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
  const { staff_id } = req.body || {};
  if (!staff_id) return fail(res, 400, 'staff_id required');
  const s = findStaffScoped(req, staff_id);
  if (!s) return fail(res, 404, 'Staff not in your tenant');
  const today = todayPP();
  const att = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(staff_id, today);
  if (!att) return fail(res, 404, 'Attendance not found for today');
  db.prepare('UPDATE attendance SET clock_out = ?, current_status = ? WHERE id = ?').run(new Date().toISOString(), 'offline', att.id);
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = CAST((julianday(?) - julianday(start_time)) * 1440 AS INTEGER) WHERE staff_id = ? AND end_time IS NULL').run(new Date().toISOString(), new Date().toISOString(), staff_id);
  emitLiveUpdate(s.tenant_id, 'force_clockout', { staff_id });
  ok(res, { id: att.id });
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
  ok(res, { id: r.lastInsertRowid || null });
});

app.put('/api/schedule/daily/:id', auth, (req, res) => {
  const id = +req.params.id;
  const sc = scopeTenant(req);
  const existing = db.prepare('SELECT id FROM schedule_daily WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!existing) return fail(res, 404, 'Not found or not in your tenant');
  const { status, shift, is_manual_override } = req.body || {};
  const fields = [], values = [];
  if (status !== undefined) { fields.push('status = ?'); values.push(status); }
  if (shift !== undefined) { fields.push('shift = ?'); values.push(shift); }
  if (is_manual_override !== undefined) { fields.push('is_manual_override = ?'); values.push(is_manual_override ? 1 : 0); }
  if (!fields.length) return ok(res, { id });
  values.push(id);
  db.prepare(`UPDATE schedule_daily SET ${fields.join(', ')} WHERE id = ?`).run(...values);
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
  const r = db.prepare('SELECT id FROM swap_requests WHERE id = ?' + sc.clause).get(id, ...sc.params);
  if (!r) return fail(res, 404, 'Not found or not in your tenant');
  db.prepare('UPDATE swap_requests SET status = ? WHERE id = ?').run('approved', id);
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

// ============ REPORTS ============
function dateRange(ym, from, to) {
  const start = from || `${ym}-01`;
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const end = to || `${ym}-${String(last).padStart(2, '0')}`;
  return { start, end };
}

app.get('/api/reports/monthly/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT staff_id) AS unique_staff,
           COUNT(*) AS total_records,
           COALESCE(SUM(total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(late_minutes),0) AS total_late_minutes,
           COALESCE(SUM(break_violations),0) AS total_break_violations,
           COALESCE(AVG(productive_ratio),0) AS avg_productive_ratio
    FROM attendance WHERE date BETWEEN ? AND ?${sc.clause}
  `).get(start, end, ...sc.params);
  ok(res, row);
});

app.get('/api/reports/attendance/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
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
    WHERE s.is_active = 1${sc.clause}
    GROUP BY s.id
    ORDER BY s.name
  `).all(start, end, start, end, ...sc.params);
  ok(res, rows);
});

app.get('/api/reports/violations/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const rows = db.prepare(`
    SELECT s.name, s.department, bl.type, bl.duration_minutes, bl.limit_minutes, DATE(bl.start_time) AS date
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.is_overtime = 1 AND DATE(bl.start_time) BETWEEN ? AND ?${sc.clause}
    ORDER BY bl.start_time DESC
  `).all(start, end, ...sc.params);
  ok(res, rows);
});

app.get('/api/reports/productivity/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const rows = db.prepare(`
    SELECT s.id AS staff_id, s.name, s.department, s.current_shift,
           COUNT(DISTINCT a.date) AS days_worked,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(a.break_violations),0) AS overtime_breaks
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1${sc.clause}
    GROUP BY s.id
    ORDER BY avg_productive_ratio DESC
  `).all(start, end, ...sc.params);
  ok(res, rows);
});

app.get('/api/reports/export/:ym', auth, async (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const sc = scopeTenant(req, 's.tenant_id');
  const rows = db.prepare(`
    SELECT s.name, s.department, s.current_shift,
           COUNT(DISTINCT CASE WHEN a.clock_in IS NOT NULL THEN a.date END) AS days_present,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1${sc.clause}
    GROUP BY s.id
  `).all(start, end, ...sc.params);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow(['Name', 'Dept', 'Shift', 'Days Present', 'Work (min)', 'Break (min)', 'Avg Productive %']);
  rows.forEach((r) => ws.addRow([r.name, r.department, r.current_shift, r.days_present, r.total_work_minutes, r.total_break_minutes, Number(r.avg_productive_ratio).toFixed(1)]));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=report-${req.params.ym}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
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
  ok(res, { settings, break_settings, shifts });
});

app.put('/api/settings/breaks', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO break_settings(tenant_id,type,daily_quota_minutes) VALUES(?,?,?) ON CONFLICT(tenant_id,type) DO UPDATE SET daily_quota_minutes=excluded.daily_quota_minutes');
  for (const [type, vals] of Object.entries(body)) upsert.run(tid, type, vals.daily_quota_minutes);
  ok(res, {});
});

app.put('/api/settings/shift-times', auth, (req, res) => {
  const tid = writeTenantId(req);
  if (!tid) return fail(res, 400, 'No tenant context');
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO shifts(tenant_id,name,start_time,end_time) VALUES(?,?,?,?) ON CONFLICT(tenant_id,name) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time');
  for (const [name, vals] of Object.entries(body)) upsert.run(tid, name, vals.start + ':00', vals.end + ':00');
  ok(res, {});
});

const KV_ROUTES = {
  '/api/settings/ip-whitelist': (body) => ['ip_whitelist', body],
  '/api/settings/offday-rules': (body) => ['off_day_rules', body],
  '/api/settings/telegram': (body) => ['telegram_admin_chat_ids', body.admin_chat_ids || []],
  '/api/settings/notification-prefs': (body) => ['notification_prefs', body],
  '/api/settings/qr-required': (body) => ['qr_required', !!body.enabled],
  '/api/settings/late-grace': (body) => ['late_grace_minutes', +body.minutes || 0],
  '/api/settings/registration-pin': (body) => ['registration_pin', String(body.pin || '')],
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
  const tok = crypto.randomBytes(6).toString('hex');
  const r = db.prepare('INSERT INTO workstations(tenant_id,name,department,qr_token,is_active) VALUES(?,?,?,?,1)').run(tid, name, department || null, tok);
  ok(res, { id: r.lastInsertRowid, qr_token: tok });
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
  const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  const sched = db.prepare('SELECT status, shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(req.staff.id, today);

  // Break quota usage hari ini per type
  const quotas = db.prepare('SELECT type, daily_quota_minutes FROM break_settings WHERE tenant_id = ?').all(req.staff.tenant_id);
  const used = db.prepare(`
    SELECT type, COALESCE(SUM(duration_minutes), 0) AS used
    FROM break_log
    WHERE staff_id = ? AND DATE(start_time) = ? AND end_time IS NOT NULL
    GROUP BY type
  `).all(req.staff.id, today);
  const usedMap = {};
  used.forEach((r) => { usedMap[r.type] = r.used || 0; });
  const breakQuotas = {};
  quotas.forEach((q) => {
    breakQuotas[q.type] = {
      limit: q.daily_quota_minutes,
      used: usedMap[q.type] || 0,
      remaining: Math.max(0, q.daily_quota_minutes - (usedMap[q.type] || 0)),
    };
  });

  const clientIp = getClientIp(req);
  const ipAllowed = isIpAllowed(req.staff.tenant_id, clientIp);

  res.json({
    success: true,
    staff: { id: req.staff.id, name: req.staff.name, department: req.staff.department, current_shift: req.staff.current_shift },
    attendance: att || null,
    schedule: sched || null,
    break_quotas: breakQuotas,
    ip_allowed: ipAllowed,
    client_ip: clientIp,
  });
});

app.post('/api/bot/clock-in', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Clock-In.`);
  }
  const today = todayPP();
  const existing = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (existing) return fail(res, 400, 'Sudah clock-in hari ini.');
  const now = new Date();
  const shiftRow = db.prepare('SELECT start_time FROM shifts WHERE tenant_id = ? AND name = ?').get(req.staff.tenant_id, req.staff.current_shift);
  const grace = +(getTenantSetting(req.staff.tenant_id, 'late_grace_minutes', 5));
  let lateMin = 0;
  if (shiftRow?.start_time) {
    const [h, m] = shiftRow.start_time.split(':').map(Number);
    const shiftStart = new Date(now); shiftStart.setHours(h, m, 0, 0);
    const diff = Math.round((now - shiftStart) / 60000);
    if (diff > grace) lateMin = diff;
  }
  db.prepare('INSERT INTO attendance(tenant_id,staff_id,date,shift,clock_in,late_minutes,ip_address,current_status) VALUES(?,?,?,?,?,?,?,?)')
    .run(req.staff.tenant_id, req.staff.id, today, req.staff.current_shift, now.toISOString(), lateMin, clientIp.slice(0, 45), 'working');
  if (lateMin > 0) {
    notifyLate(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department }, lateMin, req.staff.current_shift).catch((e) => console.warn('[bot] notifyLate:', e.message));
  }
  emitLiveUpdate(req.staff.tenant_id, 'clock_in', { staff_id: req.staff.id });
  ok(res, { clock_in: now.toISOString(), late_minutes: lateMin });
});

app.post('/api/bot/clock-out', tgAuth, (req, res) => {
  const today = todayPP();
  const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (!att) return fail(res, 400, 'Belum clock-in.');
  if (att.clock_out) return fail(res, 400, 'Sudah clock-out.');
  const now = new Date();
  const totalMin = Math.round((now - new Date(att.clock_in)) / 60000);
  const breakMin = att.total_break_minutes || 0;
  const workMin = Math.max(0, totalMin - breakMin);
  const productive = totalMin > 0 ? Math.round((workMin / totalMin) * 100) : 0;
  db.prepare('UPDATE attendance SET clock_out = ?, current_status = ?, total_work_minutes = ?, productive_ratio = ? WHERE id = ?')
    .run(now.toISOString(), 'offline', workMin, productive, att.id);
  emitLiveUpdate(req.staff.tenant_id, 'clock_out', { staff_id: req.staff.id });
  ok(res, { clock_out: now.toISOString(), total_work_minutes: workMin, productive_ratio: productive });
});

app.post('/api/bot/break-start', tgAuth, async (req, res) => {
  const { type } = req.body || {};
  if (!['smoke', 'toilet', 'outside'].includes(type)) return fail(res, 400, 'Invalid break type');
  const today = todayPP();
  const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (!att) return fail(res, 400, 'Belum clock-in.');
  if (att.current_status !== 'working') return fail(res, 400, 'Sedang break, end dulu.');
  const bs = db.prepare('SELECT daily_quota_minutes FROM break_settings WHERE tenant_id = ? AND type = ?').get(req.staff.tenant_id, type);
  const limit = bs?.daily_quota_minutes || 15;

  // Cek kuota harian: total durasi break type ini hari ini tidak boleh melebihi daily_quota
  const used = db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS used
    FROM break_log
    WHERE staff_id = ? AND type = ? AND DATE(start_time) = ? AND end_time IS NOT NULL
  `).get(req.staff.id, type, today).used || 0;

  if (used >= limit) {
    const labels = { smoke: 'Smoke', toilet: 'Toilet', outside: 'Go Out' };
    return fail(res, 400, `Kuota ${labels[type] || type} habis hari ini (${used}m/${limit}m).`);
  }

  const now = new Date();
  const ipStart = String(req.ip || req.headers['x-forwarded-for'] || '').slice(0, 45);
  // Buat break log tanpa QR — QR baru di-generate saat user klik "Back to Work"
  const r = db.prepare('INSERT INTO break_log(tenant_id,attendance_id,staff_id,type,start_time,limit_minutes,ip_address_start) VALUES(?,?,?,?,?,?,?)')
    .run(req.staff.tenant_id, att.id, req.staff.id, type, now.toISOString(), limit, ipStart);
  const statusMap = { smoke: 'smoking', toilet: 'toilet', outside: 'outside' };
  db.prepare('UPDATE attendance SET current_status = ?, break_start = ?, break_type = ?, break_limit = ? WHERE id = ?')
    .run(statusMap[type], now.toISOString(), type, limit, att.id);
  emitLiveUpdate(req.staff.tenant_id, 'break_start', { staff_id: req.staff.id, type });
  ok(res, { break_id: r.lastInsertRowid, limit_minutes: limit });
});

app.post('/api/bot/break-request-qr', tgAuth, async (req, res) => {
  const today = todayPP();
  const att = db.prepare('SELECT * FROM attendance WHERE staff_id = ? AND date = ?').get(req.staff.id, today);
  if (!att) return fail(res, 400, 'Belum clock-in.');
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
  db.prepare(`UPDATE attendance SET current_status = ?, break_start = NULL, break_type = NULL, break_limit = NULL,
              total_break_minutes = COALESCE(total_break_minutes,0) + ?, break_violations = COALESCE(break_violations,0) + ?
              WHERE staff_id = ? AND date = ?`)
    .run('working', dur, overtime, req.staff.id, todayPP());
  if (overtime) {
    notifyOvertime(req.staff.tenant_id, { name: req.staff.name, department: req.staff.department }, bl.type, dur, bl.limit_minutes).catch((e) => console.warn('[bot] notifyOvertime:', e.message));
  }
  emitLiveUpdate(req.staff.tenant_id, 'break_end', { staff_id: req.staff.id });
  ok(res, { duration_minutes: dur, is_overtime: !!overtime });
});

app.post('/api/bot/break-end', tgAuth, (req, res) => {
  const clientIp = getClientIp(req);
  if (!isIpAllowed(req.staff.tenant_id, clientIp)) {
    return fail(res, 403, `Anda di luar jaringan kantor (IP: ${clientIp}). Kembali ke kantor dan gunakan IP kantor untuk Back to Work.`);
  }
  const today = todayPP();
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
              WHERE staff_id = ? AND date = ?`)
    .run('working', dur, overtime, req.staff.id, today);
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
});
