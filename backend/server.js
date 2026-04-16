import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import { db, getSetting, setSetting } from './db.js';

const PORT = process.env.PORT || 8000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));

function ok(res, data, extra = {}) { return res.json({ success: true, data, ...extra }); }
function fail(res, status, message) { return res.status(status).json({ success: false, message }); }

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return fail(res, 401, 'Missing token');
  try {
    req.user = jwt.verify(tok, JWT_SECRET);
    next();
  } catch {
    return fail(res, 401, 'Invalid token');
  }
}

// ============ AUTH ============
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, 400, 'Username and password required');
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return fail(res, 401, 'Invalid credentials');
  const token = jwt.sign({ id: u.id, username: u.username, role: u.role, name: u.name }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: u.id, username: u.username, role: u.role, name: u.name } });
});

// ============ STAFF ============
app.get('/api/staff', auth, (req, res) => {
  const { shift, category, department } = req.query;
  let q = 'SELECT * FROM staff WHERE 1=1';
  const params = [];
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
  const r = db.prepare(`INSERT INTO staff(name,category,current_shift,department,phone,telegram_id,telegram_username,join_date,is_active,is_approved)
                        VALUES(?,?,?,?,?,?,?,?,1,1)`).run(b.name, b.category || 'indonesian', b.current_shift || 'morning', b.department || null, b.phone || null, b.telegram_id || null, b.telegram_username || null, b.join_date || null);
  ok(res, { id: r.lastInsertRowid });
});

app.put('/api/staff/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
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
  db.prepare('UPDATE staff SET is_approved = 1 WHERE id = ?').run(id);
  ok(res, { id });
});

app.delete('/api/staff/:id', auth, (req, res) => {
  const id = +req.params.id;
  const s = db.prepare('SELECT * FROM staff WHERE id = ?').get(id);
  if (!s) return fail(res, 404, 'Not found');
  const newVal = s.is_active ? 0 : 1;
  db.prepare('UPDATE staff SET is_active = ? WHERE id = ?').run(newVal, id);
  res.json({ success: true, message: `${s.name} ${newVal ? 'reactivated' : 'deactivated'}.` });
});

app.delete('/api/staff/:id/permanent', auth, (req, res) => {
  const id = +req.params.id;
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  ok(res, { id });
});

// ============ ACTIVITY ============
function todayPP() {
  return new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10);
}

app.get('/api/activity/live', auth, (req, res) => {
  const today = todayPP();
  const staff = db.prepare(`
    SELECT s.id, s.name, s.department, s.category, s.current_shift,
           a.clock_in, a.clock_out, a.late_minutes, a.current_status,
           a.break_start, a.break_limit,
           sd.status AS schedule_status
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date = ?
    LEFT JOIN schedule_daily sd ON sd.staff_id = s.id AND sd.date = ?
    WHERE s.is_active = 1
    ORDER BY s.name
  `).all(today, today);

  const breaks = db.prepare(`
    SELECT bl.id, s.name, bl.type, bl.start_time, bl.limit_minutes
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.end_time IS NULL AND DATE(bl.start_time) = ?
  `).all(today).map((b) => ({
    ...b,
    elapsed_minutes: Math.max(0, (Date.now() - new Date(b.start_time).getTime()) / 60000),
  }));

  const hour = new Date(Date.now() + 7 * 3600000).getUTCHours();
  const currentShift = hour >= 9 && hour < 14 ? 'morning' : hour >= 14 && hour < 21 ? 'middle' : 'night';

  ok(res, { staff, active_breaks: breaks, stats: { current_shift: currentShift } });
});

app.get('/api/activity/active-breaks-qr', auth, (req, res) => {
  const today = todayPP();
  const rows = db.prepare(`
    SELECT bl.id, s.name AS staff_name, s.department, bl.type, bl.start_time, bl.qr_token, bl.qr_expires_at
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.end_time IS NULL AND bl.qr_token IS NOT NULL AND DATE(bl.start_time) = ?
  `).all(today);
  ok(res, rows);
});

app.post('/api/activity/force-clockout', auth, (req, res) => {
  const { staff_id } = req.body || {};
  if (!staff_id) return fail(res, 400, 'staff_id required');
  const today = todayPP();
  const att = db.prepare('SELECT id FROM attendance WHERE staff_id = ? AND date = ?').get(staff_id, today);
  if (!att) return fail(res, 404, 'Attendance not found for today');
  db.prepare('UPDATE attendance SET clock_out = ?, current_status = ? WHERE id = ?').run(new Date().toISOString(), 'offline', att.id);
  db.prepare('UPDATE break_log SET end_time = ?, duration_minutes = CAST((julianday(?) - julianday(start_time)) * 1440 AS INTEGER) WHERE staff_id = ? AND end_time IS NULL').run(new Date().toISOString(), new Date().toISOString(), staff_id);
  ok(res, { id: att.id });
});

app.get('/api/activity/log/:date', auth, (req, res) => {
  const { date } = req.params;
  const rows = db.prepare(`
    SELECT a.id, s.name, s.department, a.shift, a.clock_in, a.clock_out, a.late_minutes, a.ip_address, a.productive_ratio
    FROM attendance a
    JOIN staff s ON s.id = a.staff_id
    WHERE a.date = ?
    ORDER BY a.clock_in
  `).all(date);

  const breaks = db.prepare(`SELECT attendance_id, type, start_time, end_time, duration_minutes, is_overtime FROM break_log WHERE DATE(start_time) = ?`).all(date);
  const byAtt = {};
  breaks.forEach((b) => { (byAtt[b.attendance_id] = byAtt[b.attendance_id] || []).push(b); });
  rows.forEach((r) => { r.breaks = byAtt[r.id] || []; });
  ok(res, rows);
});

// ============ SCHEDULE ============
app.get('/api/schedule/:ym', auth, (req, res) => {
  const ym = req.params.ym;
  const sched = db.prepare('SELECT * FROM schedules WHERE month = ?').get(ym) || { status: null };
  const staff = db.prepare('SELECT id, name, category, department FROM staff WHERE is_active = 1 ORDER BY name').all();
  const days = db.prepare('SELECT * FROM schedule_daily WHERE date LIKE ? ORDER BY date').all(ym + '-%');
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
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const staff = db.prepare('SELECT id, current_shift FROM staff WHERE is_active = 1').all();

  db.prepare('INSERT OR IGNORE INTO schedules(month,status) VALUES(?,?)').run(ym, 'draft');
  db.prepare('UPDATE schedules SET status = ? WHERE month = ?').run('draft', ym);

  const delSD = db.prepare('DELETE FROM schedule_daily WHERE date LIKE ? AND is_manual_override = 0');
  const ins = db.prepare('INSERT OR IGNORE INTO schedule_daily(staff_id,date,status,shift) VALUES(?,?,?,?)');
  const tx = db.transaction(() => {
    delSD.run(ym + '-%');
    staff.forEach((s) => {
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${ym}-${String(d).padStart(2, '0')}`;
        const dow = new Date(y, m - 1, d).getDay();
        const off = dow === 0 && (s.id + d) % 4 === 0;
        ins.run(s.id, date, off ? 'off' : 'work', s.current_shift);
      }
    });
  });
  tx();
  ok(res, { month: ym });
});

app.put('/api/schedule/:ym/approve', auth, (req, res) => {
  const ym = req.params.ym;
  db.prepare('INSERT OR IGNORE INTO schedules(month,status) VALUES(?,?)').run(ym, 'draft');
  db.prepare('UPDATE schedules SET status = ? WHERE month = ?').run('approved', ym);
  ok(res, { month: ym });
});

app.post('/api/schedule/:ym/copy-last-month', auth, (req, res) => {
  const ym = req.params.ym;
  const [y, m] = ym.split('-').map(Number);
  const prevDate = new Date(y, m - 2, 1);
  const prevYm = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const prevDays = db.prepare('SELECT staff_id, strftime("%d", date) AS dd, status, shift FROM schedule_daily WHERE date LIKE ?').all(prevYm + '-%');
  if (!prevDays.length) return fail(res, 404, `No data for ${prevYm}`);
  const daysInMonth = new Date(y, m, 0).getDate();
  const ins = db.prepare('INSERT OR IGNORE INTO schedule_daily(staff_id,date,status,shift) VALUES(?,?,?,?)');
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO schedules(month,status) VALUES(?,?)').run(ym, 'draft');
    prevDays.forEach((p) => {
      const day = parseInt(p.dd);
      if (day > daysInMonth) return;
      ins.run(p.staff_id, `${ym}-${String(day).padStart(2, '0')}`, p.status, p.shift);
    });
  });
  tx();
  res.json({ success: true, message: `Copied ${prevDays.length} entries from ${prevYm}` });
});

app.post('/api/schedule/:ym/import', auth, (req, res) => {
  const ym = req.params.ym;
  const entries = req.body?.entries || [];
  const errors = [];
  let imported = 0;
  const findStaff = db.prepare('SELECT id FROM staff WHERE LOWER(name) = LOWER(?)');
  const ins = db.prepare('INSERT INTO schedule_daily(staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,?,1) ON CONFLICT(staff_id,date) DO UPDATE SET status=excluded.status, shift=excluded.shift, is_manual_override=1');
  const tx = db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO schedules(month,status) VALUES(?,?)').run(ym, 'draft');
    for (const e of entries) {
      const s = findStaff.get(e.staff_name);
      if (!s) { errors.push(`Staff not found: ${e.staff_name}`); continue; }
      try { ins.run(s.id, e.date, e.status, e.shift); imported++; }
      catch (err) { errors.push(`${e.staff_name} ${e.date}: ${err.message}`); }
    }
  });
  tx();
  res.json({ success: true, message: `Imported ${imported} entries${errors.length ? ` (${errors.length} errors)` : ''}`, errors });
});

app.get('/api/schedule/:ym/export', auth, async (req, res) => {
  const ym = req.params.ym;
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const staff = db.prepare('SELECT id, name, department FROM staff WHERE is_active = 1 ORDER BY name').all();
  const days = db.prepare('SELECT staff_id, date, status, shift FROM schedule_daily WHERE date LIKE ?').all(ym + '-%');
  const key = (sid, d) => `${sid}_${d}`;
  const lookup = {};
  days.forEach((x) => { lookup[key(x.staff_id, x.date)] = x; });

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(`Schedule ${ym}`);
  const header = ['Name', 'Department', ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  ws.addRow(header);
  const shiftMap = { morning: 'M', middle: 'D', night: 'N' };
  staff.forEach((s) => {
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
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=schedule-${ym}.xlsx`);
  await wb.xlsx.write(res);
  res.end();
});

app.post('/api/schedule/daily', auth, (req, res) => {
  const { staff_id, date, status, shift, is_manual_override } = req.body || {};
  if (!staff_id || !date) return fail(res, 400, 'staff_id and date required');
  const r = db.prepare(`INSERT INTO schedule_daily(staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,?,?)
                        ON CONFLICT(staff_id,date) DO UPDATE SET status=excluded.status, shift=excluded.shift, is_manual_override=excluded.is_manual_override`)
                .run(staff_id, date, status || 'work', shift || 'morning', is_manual_override ? 1 : 0);
  ok(res, { id: r.lastInsertRowid || null });
});

app.put('/api/schedule/daily/:id', auth, (req, res) => {
  const id = +req.params.id;
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
const swapJoin = `SELECT sw.id, sw.target_date, sw.current_shift, sw.reason, sw.status, sw.reject_reason, sw.created_at,
                         s.name AS requester_name, s.department AS requester_dept
                  FROM swap_requests sw
                  JOIN staff s ON s.id = sw.requester_id`;

app.get('/api/swap/pending', auth, (req, res) => {
  ok(res, db.prepare(swapJoin + ' WHERE sw.status = ? ORDER BY sw.created_at DESC').all('pending'));
});
app.get('/api/swap/history', auth, (req, res) => {
  ok(res, db.prepare(swapJoin + ' ORDER BY sw.created_at DESC').all());
});
app.put('/api/swap/:id/approve', auth, (req, res) => {
  db.prepare('UPDATE swap_requests SET status = ? WHERE id = ?').run('approved', +req.params.id);
  ok(res, { id: +req.params.id });
});
app.put('/api/swap/:id/reject', auth, (req, res) => {
  const { reject_reason } = req.body || {};
  db.prepare('UPDATE swap_requests SET status = ?, reject_reason = ? WHERE id = ?').run('rejected', reject_reason || '', +req.params.id);
  ok(res, { id: +req.params.id });
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
  const row = db.prepare(`
    SELECT COUNT(DISTINCT staff_id) AS unique_staff,
           COUNT(*) AS total_records,
           COALESCE(SUM(total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(late_minutes),0) AS total_late_minutes,
           COALESCE(SUM(break_violations),0) AS total_break_violations,
           COALESCE(AVG(productive_ratio),0) AS avg_productive_ratio
    FROM attendance WHERE date BETWEEN ? AND ?
  `).get(start, end);
  ok(res, row);
});

app.get('/api/reports/attendance/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
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
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY s.name
  `).all(start, end, start, end);
  ok(res, rows);
});

app.get('/api/reports/violations/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const rows = db.prepare(`
    SELECT s.name, s.department, bl.type, bl.duration_minutes, bl.limit_minutes, DATE(bl.start_time) AS date
    FROM break_log bl
    JOIN staff s ON s.id = bl.staff_id
    WHERE bl.is_overtime = 1 AND DATE(bl.start_time) BETWEEN ? AND ?
    ORDER BY bl.start_time DESC
  `).all(start, end);
  ok(res, rows);
});

app.get('/api/reports/productivity/:ym', auth, (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const rows = db.prepare(`
    SELECT s.id AS staff_id, s.name, s.department, s.current_shift,
           COUNT(DISTINCT a.date) AS days_worked,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(SUM(a.break_violations),0) AS overtime_breaks
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1
    GROUP BY s.id
    ORDER BY avg_productive_ratio DESC
  `).all(start, end);
  ok(res, rows);
});

app.get('/api/reports/export/:ym', auth, async (req, res) => {
  const { start, end } = dateRange(req.params.ym, req.query.from, req.query.to);
  const rows = db.prepare(`
    SELECT s.name, s.department, s.current_shift,
           COUNT(DISTINCT CASE WHEN a.clock_in IS NOT NULL THEN a.date END) AS days_present,
           COALESCE(SUM(a.total_work_minutes),0) AS total_work_minutes,
           COALESCE(SUM(a.total_break_minutes),0) AS total_break_minutes,
           COALESCE(AVG(a.productive_ratio),0) AS avg_productive_ratio
    FROM staff s
    LEFT JOIN attendance a ON a.staff_id = s.id AND a.date BETWEEN ? AND ?
    WHERE s.is_active = 1
    GROUP BY s.id
  `).all(start, end);
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
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach((r) => {
    try { settings[r.key] = { value: JSON.parse(r.value) }; }
    catch { settings[r.key] = { value: r.value }; }
  });
  const break_settings = db.prepare('SELECT * FROM break_settings').all();
  const shifts = db.prepare('SELECT * FROM shifts').all();
  ok(res, { settings, break_settings, shifts });
});

app.put('/api/settings/breaks', auth, (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO break_settings(type,daily_quota_minutes) VALUES(?,?) ON CONFLICT(type) DO UPDATE SET daily_quota_minutes=excluded.daily_quota_minutes');
  for (const [type, vals] of Object.entries(body)) {
    upsert.run(type, vals.daily_quota_minutes);
  }
  ok(res, {});
});

app.put('/api/settings/shift-times', auth, (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare('INSERT INTO shifts(name,start_time,end_time) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time');
  for (const [name, vals] of Object.entries(body)) {
    upsert.run(name, vals.start + ':00', vals.end + ':00');
  }
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
    const [k, v] = fn(req.body || {});
    setSetting(k, v);
    ok(res, { [k]: v });
  });
}

app.get('/api/settings/workstations', auth, (req, res) => {
  ok(res, db.prepare('SELECT * FROM workstations ORDER BY name').all());
});
app.post('/api/settings/workstations', auth, (req, res) => {
  const { name, department } = req.body || {};
  if (!name) return fail(res, 400, 'name required');
  const tok = crypto.randomBytes(6).toString('hex');
  const r = db.prepare('INSERT INTO workstations(name,department,qr_token,is_active) VALUES(?,?,?,1)').run(name, department || null, tok);
  ok(res, { id: r.lastInsertRowid, qr_token: tok });
});
app.put('/api/settings/workstations/:id/toggle', auth, (req, res) => {
  const id = +req.params.id;
  db.prepare('UPDATE workstations SET is_active = 1 - is_active WHERE id = ?').run(id);
  ok(res, { id });
});
app.delete('/api/settings/workstations/:id', auth, (req, res) => {
  db.prepare('DELETE FROM workstations WHERE id = ?').run(+req.params.id);
  ok(res, {});
});

// ============ ERROR HANDLER ============
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ success: false, message: err.message });
});

app.listen(PORT, () => console.log(`[backend] listening on http://localhost:${PORT}`));
