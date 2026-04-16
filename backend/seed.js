import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, setSetting } from './db.js';

const FORCE = process.env.FORCE_SEED === 'true';
const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
const staffCount = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
if ((userCount > 0 || staffCount > 0) && !FORCE) {
  console.log(`[seed] DB already populated (${userCount} users, ${staffCount} staff) — skipping.`);
  console.log('[seed] To force re-seed, set env FORCE_SEED=true');
  process.exit(0);
}

const DEPARTMENTS = ['Customer Service', 'Finance', 'Captain', 'SEO Marketing', 'Social Media Marketing', 'CRM', 'Telemarketing'];
const SHIFTS = ['morning', 'middle', 'night'];
const CATEGORIES = ['indonesian', 'local'];

const indoNames = ['Budi Santoso', 'Siti Rahma', 'Agus Wijaya', 'Dewi Lestari', 'Rudi Hartono', 'Ayu Pratiwi', 'Joko Susilo', 'Ratna Sari', 'Andi Nugroho', 'Maya Putri'];
const localNames = ['Sok Piseth', 'Chan Srey Leak', 'Keo Vannak', 'Mom Sokha', 'Heng Dara', 'Srey Pich'];

function seedAdmin() {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (exists) return;
  const hash = bcrypt.hashSync('admin123', 8);
  db.prepare('INSERT INTO users(username,password_hash,name,role) VALUES(?,?,?,?)').run('admin', hash, 'Administrator', 'admin');
  console.log('[seed] admin user created (admin / admin123)');
}

function seedStaff() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
  if (count > 0) return;
  const ins = db.prepare('INSERT INTO staff(name,category,current_shift,department,phone,telegram_username,join_date,is_active,is_approved) VALUES(?,?,?,?,?,?,?,?,?)');
  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const today = new Date().toISOString().slice(0, 10);
  indoNames.forEach((n, i) => ins.run(n, 'indonesian', SHIFTS[i % 3], rnd(DEPARTMENTS), `+62812345${String(i).padStart(4, '0')}`, n.toLowerCase().replace(/\s+/g, '_'), today, 1, i < 9 ? 1 : 0));
  localNames.forEach((n, i) => ins.run(n, 'local', SHIFTS[i % 3], rnd(DEPARTMENTS), `+85512345${String(i).padStart(4, '0')}`, n.toLowerCase().replace(/\s+/g, ''), today, 1, 1));
  console.log('[seed] staff inserted:', indoNames.length + localNames.length);
}

function seedSchedule() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const existing = db.prepare('SELECT id FROM schedules WHERE month = ?').get(ym);
  if (existing) return;

  db.prepare('INSERT INTO schedules(month,status) VALUES(?,?)').run(ym, 'approved');
  const staff = db.prepare('SELECT id, current_shift FROM staff WHERE is_active = 1').all();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const ins = db.prepare('INSERT OR IGNORE INTO schedule_daily(staff_id,date,status,shift) VALUES(?,?,?,?)');
  const tx = db.transaction(() => {
    staff.forEach((s) => {
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${ym}-${String(d).padStart(2, '0')}`;
        const dayOfWeek = new Date(now.getFullYear(), now.getMonth(), d).getDay();
        const off = dayOfWeek === 0 && (s.id + d) % 3 === 0;
        ins.run(s.id, date, off ? 'off' : 'work', s.current_shift);
      }
    });
  });
  tx();
  console.log('[seed] schedule seeded for', ym);
}

function seedAttendance() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE date = ?').get(today).c;
  if (existing > 0) return;

  const staff = db.prepare('SELECT id, current_shift FROM staff WHERE is_active = 1').all();
  const shiftStart = { morning: '09:00', middle: '14:00', night: '21:00' };
  const insAtt = db.prepare(`INSERT INTO attendance(staff_id,date,shift,clock_in,late_minutes,ip_address,current_status,total_work_minutes,total_break_minutes,productive_ratio,break_start,break_type,break_limit) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insBreak = db.prepare(`INSERT INTO break_log(attendance_id,staff_id,type,start_time,end_time,duration_minutes,limit_minutes,is_overtime,qr_token,qr_expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`);

  const now = new Date();
  staff.forEach((s, idx) => {
    const sched = db.prepare('SELECT status FROM schedule_daily WHERE staff_id = ? AND date = ?').get(s.id, today);
    if (sched?.status === 'off') return;
    if (idx % 7 === 6) return;

    const shiftBase = shiftStart[s.current_shift] || '09:00';
    const [h, m] = shiftBase.split(':').map(Number);
    const late = idx % 5 === 0 ? 12 : 0;
    const clockIn = new Date(now); clockIn.setHours(h, m + late, 0, 0);
    const currentStatus = idx % 6 === 0 ? 'smoking' : idx % 6 === 1 ? 'toilet' : 'working';
    const breakStart = currentStatus !== 'working' ? new Date(now.getTime() - 8 * 60000).toISOString() : null;
    const breakType = currentStatus === 'working' ? null : (currentStatus === 'smoking' ? 'smoke' : 'toilet');
    const breakLimit = breakType === 'smoke' ? 20 : breakType === 'toilet' ? 30 : null;
    const workMins = 240 + (idx * 17) % 90;
    const breakMins = 15 + (idx * 3) % 20;
    const productive = Math.max(50, Math.min(99, 70 + (idx * 5) % 30));

    const res = insAtt.run(s.id, today, s.current_shift, clockIn.toISOString(), late, `45.16.18.${100 + idx}`, currentStatus, workMins, breakMins, productive, breakStart, breakType, breakLimit);

    const bcount = 1 + (idx % 3);
    for (let k = 0; k < bcount; k++) {
      const bStart = new Date(clockIn.getTime() + (60 + k * 90) * 60000);
      const bType = ['smoke', 'toilet', 'outside'][k % 3];
      const bLimit = bType === 'smoke' ? 20 : bType === 'toilet' ? 30 : 10;
      const bDur = bLimit + (k === 0 && idx % 4 === 0 ? 8 : -3);
      const bEnd = new Date(bStart.getTime() + bDur * 60000);
      insBreak.run(res.lastInsertRowid, s.id, bType, bStart.toISOString(), bEnd.toISOString(), bDur, bLimit, bDur > bLimit ? 1 : 0, null, null);
    }

    if (breakStart && breakType) {
      const qrToken = crypto.randomBytes(6).toString('hex');
      const qrExp = new Date(Date.now() + 5 * 60000).toISOString();
      insBreak.run(res.lastInsertRowid, s.id, breakType, breakStart, null, null, breakLimit, 0, qrToken, qrExp);
    }
  });
  console.log('[seed] attendance seeded for', today);
}

function seedSwaps() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM swap_requests').get().c;
  if (existing > 0) return;
  const staff = db.prepare('SELECT id, current_shift FROM staff WHERE is_active = 1 LIMIT 6').all();
  const ins = db.prepare('INSERT INTO swap_requests(requester_id,target_date,current_shift,reason,status) VALUES(?,?,?,?,?)');
  const now = new Date();
  staff.forEach((s, i) => {
    const d = new Date(now); d.setDate(d.getDate() + (i + 1));
    const date = d.toISOString().slice(0, 10);
    const status = i < 2 ? 'pending' : i < 4 ? 'approved' : 'rejected';
    const reasons = ['Keperluan keluarga', 'Sakit', 'Janji penting', 'Ingin tukar dengan Budi'];
    ins.run(s.id, date, s.current_shift, reasons[i % reasons.length], status);
  });
  console.log('[seed] swap requests seeded');
}

function seedSettings() {
  const defaults = {
    ip_whitelist: { prefixes: ['45.16.18.'] },
    off_day_rules: { per_person_per_month: 4, max_indo_off_per_shift_per_day: 2, max_local_off_per_shift_per_day: 2 },
    telegram_admin_chat_ids: [],
    notification_prefs: { muted_types: [] },
    qr_required: false,
    late_grace_minutes: 5,
    registration_pin: '1234',
  };
  Object.entries(defaults).forEach(([k, v]) => {
    const exists = db.prepare('SELECT key FROM settings WHERE key = ?').get(k);
    if (!exists) setSetting(k, v);
  });

  const breaks = [
    { type: 'smoke', daily_quota_minutes: 20 },
    { type: 'toilet', daily_quota_minutes: 30 },
    { type: 'outside', daily_quota_minutes: 10 },
  ];
  const insBreak = db.prepare('INSERT OR IGNORE INTO break_settings(type,daily_quota_minutes) VALUES(?,?)');
  breaks.forEach((b) => insBreak.run(b.type, b.daily_quota_minutes));

  const shifts = [
    { name: 'morning', start_time: '09:00:00', end_time: '21:00:00' },
    { name: 'middle', start_time: '14:00:00', end_time: '02:00:00' },
    { name: 'night', start_time: '21:00:00', end_time: '09:00:00' },
  ];
  const insShift = db.prepare('INSERT OR IGNORE INTO shifts(name,start_time,end_time) VALUES(?,?,?)');
  shifts.forEach((s) => insShift.run(s.name, s.start_time, s.end_time));

  const wsCount = db.prepare('SELECT COUNT(*) AS c FROM workstations').get().c;
  if (wsCount === 0) {
    const insWs = db.prepare('INSERT INTO workstations(name,department,qr_token,is_active) VALUES(?,?,?,?)');
    insWs.run('Front Desk', 'Customer Service', crypto.randomBytes(6).toString('hex'), 1);
    insWs.run('Finance Station', 'Finance', crypto.randomBytes(6).toString('hex'), 1);
  }
  console.log('[seed] settings/breaks/shifts/workstations seeded');
}

seedAdmin();
seedStaff();
seedSchedule();
seedAttendance();
seedSwaps();
seedSettings();
console.log('[seed] done.');
