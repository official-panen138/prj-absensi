// Shared approval logic untuk swap & leave requests.
// Dipakai oleh server.js (REST endpoints) DAN bot.js (Telegram callbacks)
// supaya logic identik di keduanya.
import { db } from './db.js';

// === SWAP APPROVAL ===
// sw = row dari swap_requests. Modifies schedule_daily sesuai swap_type.
export function applySwapApproval(sw) {
  const type = sw.swap_type || (sw.target_staff_id ? 'trade' : 'sick');
  if (type === 'trade') {
    const partnerDate = sw.partner_date || sw.target_date;
    const reqSched = db.prepare('SELECT shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.requester_id, sw.target_date);
    const partnerSched = db.prepare('SELECT shift FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.target_staff_id, partnerDate);
    if (!reqSched || !partnerSched) return { error: 'Schedule sudah berubah, swap tidak valid lagi' };
    db.transaction(() => {
      db.prepare('UPDATE schedule_daily SET shift = ?, is_manual_override = 1 WHERE staff_id = ? AND date = ?').run(partnerSched.shift, sw.requester_id, sw.target_date);
      db.prepare('UPDATE schedule_daily SET shift = ?, is_manual_override = 1 WHERE staff_id = ? AND date = ?').run(reqSched.shift, sw.target_staff_id, partnerDate);
    })();
  } else if (type === 'move_off') {
    const original = db.prepare('SELECT * FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.requester_id, sw.target_date);
    const newDate = db.prepare('SELECT * FROM schedule_daily WHERE staff_id = ? AND date = ?').get(sw.requester_id, sw.partner_date);
    if (!original || original.status !== 'off') return { error: 'Off day asli sudah berubah, swap tidak valid' };
    if (!newDate || newDate.status !== 'work') return { error: 'Tanggal baru sudah berubah / bukan work, swap tidak valid' };
    const staff = db.prepare('SELECT current_shift FROM staff WHERE id = ?').get(sw.requester_id);
    db.transaction(() => {
      db.prepare("UPDATE schedule_daily SET status = 'work', shift = ?, is_manual_override = 1 WHERE staff_id = ? AND date = ?")
        .run(staff?.current_shift || 'morning', sw.requester_id, sw.target_date);
      db.prepare("UPDATE schedule_daily SET status = 'off', is_manual_override = 1 WHERE staff_id = ? AND date = ?")
        .run(sw.requester_id, sw.partner_date);
    })();
  } else if (type === 'sick') {
    db.prepare(`INSERT INTO schedule_daily(tenant_id,staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,'sick','morning',1)
                ON CONFLICT(staff_id,date) DO UPDATE SET status='sick', is_manual_override=1`)
      .run(sw.tenant_id, sw.requester_id, sw.target_date);
  }
  return { ok: true };
}

// === LEAVE APPROVAL ===
// lr = row dari leave_requests. Insert/update schedule_daily status='leave'
// untuk semua tanggal di range start_date..end_date dan mark request as approved.
export function applyLeaveApproval(lr) {
  const start = new Date(lr.start_date + 'T00:00:00');
  const end = new Date(lr.end_date + 'T00:00:00');
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { error: 'Tanggal cuti tidak valid' };
  const upsert = db.prepare(`INSERT INTO schedule_daily(tenant_id,staff_id,date,status,shift,is_manual_override) VALUES(?,?,?,'leave','morning',1)
                             ON CONFLICT(staff_id,date) DO UPDATE SET status='leave', is_manual_override=1`);
  db.transaction(() => {
    for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
      const ds = new Date(t).toISOString().slice(0, 10);
      upsert.run(lr.tenant_id, lr.staff_id, ds);
    }
    db.prepare("UPDATE leave_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?").run(lr.id);
  })();
  return { ok: true };
}

// === PRODUCTIVITY CALCULATION ===
// Formula: score = max(0, expected - late - overbreak); ratio = score/expected*100
// Dipakai oleh clockOutImpl + Reports query untuk konsistensi rounding.
export function calculateProductiveRatio(expectedWork, lateMin, overbreakMin) {
  const score = Math.max(0, (expectedWork || 0) - (lateMin || 0) - (overbreakMin || 0));
  const ratio = expectedWork > 0 ? Math.round((score / expectedWork) * 1000) / 10 : 0;
  return { score, ratio };
}
