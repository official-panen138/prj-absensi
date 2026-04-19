import sharp from 'sharp';
import { db } from './db.js';

const ESC = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COLOR = {
  bg: '#0f172a',
  panel: '#1f2937',
  border: '#374151',
  text: '#f3f4f6',
  textMuted: '#9ca3af',
  accent: '#34d399',
  weekend: '#fb7185',
  morning: { fill: '#10b981', text: '#fff' },
  middle:  { fill: '#3b82f6', text: '#fff' },
  night:   { fill: '#8b5cf6', text: '#fff' },
  off:     { fill: '#dc2626', text: '#fff' },
  sick:    { fill: '#d97706', text: '#fff' },
  leave:   { fill: '#0ea5e9', text: '#fff' },
  empty:   { fill: '#1f2937', text: '#6b7280' },
  marked:  { stroke: '#fbbf24', width: 3 },
};

function cellStyle(sd) {
  if (!sd) return { ...COLOR.empty, label: '·' };
  if (sd.status === 'work') {
    const c = sd.shift === 'middle' ? COLOR.middle : sd.shift === 'night' ? COLOR.night : COLOR.morning;
    return { ...c, label: sd.shift === 'morning' ? 'M' : sd.shift === 'middle' ? 'D' : 'N' };
  }
  if (sd.status === 'off') return { ...COLOR.off, label: 'OFF' };
  if (sd.status === 'sick') return { ...COLOR.sick, label: 'SCK' };
  if (sd.status === 'leave') return { ...COLOR.leave, label: 'LV' };
  return { ...COLOR.empty, label: '?' };
}

function getMonthDates(focusDate) {
  const focus = new Date(focusDate + 'T00:00:00');
  const y = focus.getFullYear();
  const m = focus.getMonth();
  const last = new Date(y, m + 1, 0).getDate();
  return Array.from({ length: last }, (_, i) => {
    const d = new Date(y, m, i + 1);
    return d.toISOString().slice(0, 10);
  });
}

function getMonthKey(date) {
  return date.slice(0, 7); // YYYY-MM
}

function fetchScheduleData(deptId, requesterId, focusDate) {
  const dates = getMonthDates(focusDate);
  const staff = deptId
    ? db.prepare('SELECT id, name FROM staff WHERE department_id = ? AND is_active = 1 AND is_approved = 1 ORDER BY (id = ?) DESC, name').all(deptId, requesterId)
    : db.prepare('SELECT id, name FROM staff WHERE id = ?').all(requesterId);
  const sIds = staff.map((s) => s.id);
  if (!sIds.length) return { staff: [], dates, sched: {} };
  const sPlace = sIds.map(() => '?').join(',');
  const dPlace = dates.map(() => '?').join(',');
  const rows = db.prepare(`SELECT staff_id, date, status, shift FROM schedule_daily WHERE staff_id IN (${sPlace}) AND date IN (${dPlace})`).all(...sIds, ...dates);
  const sched = {};
  rows.forEach((r) => { sched[`${r.staff_id}_${r.date}`] = r; });
  return { staff, dates, sched };
}

function renderSvg({ staff, dates, sched, marked, title, requesterId }) {
  const cellW = 32, cellH = 28, nameW = 170;
  const headerH = 60, footerH = 30;
  const W = nameW + cellW * dates.length + 20;
  const H = headerH + cellH * staff.length + footerH + 20;
  const dayLabels = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']; // dow
  const FF = 'DejaVu Sans, Arial, sans-serif';

  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`];
  parts.push(`<rect width="100%" height="100%" fill="${COLOR.bg}"/>`);
  // Title
  parts.push(`<text x="10" y="22" fill="${COLOR.accent}" font-size="13" font-weight="bold" font-family="${FF}">${ESC(title)}</text>`);
  // Date headers (day-of-week + day number)
  dates.forEach((d, i) => {
    const x = nameW + i * cellW + cellW / 2;
    const dt = new Date(d + 'T00:00:00');
    const dow = (dt.getDay() + 6) % 7; // 0=Mon..6=Sun
    const isWeekend = dow === 5 || dow === 6;
    parts.push(`<text x="${x}" y="${38}" fill="${isWeekend ? COLOR.weekend : COLOR.textMuted}" font-size="8" text-anchor="middle" font-family="${FF}">${dayLabels[dow]}</text>`);
    parts.push(`<text x="${x}" y="${52}" fill="${isWeekend ? COLOR.weekend : COLOR.text}" font-size="10" text-anchor="middle" font-family="${FF}" font-weight="bold">${d.slice(8, 10)}</text>`);
  });
  // Rows
  staff.forEach((s, ri) => {
    const y = headerH + ri * cellH;
    const isReq = s.id === requesterId;
    if (isReq) {
      parts.push(`<rect x="0" y="${y}" width="${nameW}" height="${cellH}" fill="${COLOR.panel}"/>`);
    }
    const namePrefix = isReq ? '> ' : '  ';
    parts.push(`<text x="8" y="${y + cellH / 2 + 4}" fill="${isReq ? COLOR.accent : COLOR.text}" font-size="11" font-weight="${isReq ? 'bold' : 'normal'}" font-family="${FF}">${ESC(namePrefix + s.name.slice(0, 22))}</text>`);
    dates.forEach((d, ci) => {
      const cellX = nameW + ci * cellW;
      const sd = sched[`${s.id}_${d}`];
      const style = cellStyle(sd);
      const isMarked = marked && marked[s.id] && marked[s.id].includes(d);
      parts.push(`<rect x="${cellX + 1}" y="${y + 1}" width="${cellW - 2}" height="${cellH - 2}" fill="${style.fill}" rx="3" stroke="${isMarked ? COLOR.marked.stroke : 'none'}" stroke-width="${isMarked ? COLOR.marked.width : 0}"/>`);
      // Compact label — kalau cell width pas-pasan, single char untuk OFF/SCK/LV
      let label = style.label;
      if (label.length > 1 && cellW < 40) {
        label = label === 'OFF' ? 'O' : label === 'SCK' ? 'S' : label === 'LV' ? 'L' : label.slice(0, 2);
      }
      parts.push(`<text x="${cellX + cellW / 2}" y="${y + cellH / 2 + 4}" fill="${style.text}" font-size="11" font-weight="bold" text-anchor="middle" font-family="${FF}">${ESC(label)}</text>`);
    });
  });
  // Footer legend
  const fy = headerH + staff.length * cellH + 18;
  parts.push(`<text x="10" y="${fy}" fill="${COLOR.textMuted}" font-size="9" font-family="${FF}">M=Morning  D=Middle  N=Night  O=Off  S=Sick  L=Leave   &gt;=requester   yellow border=affected</text>`);
  parts.push(`</svg>`);
  return parts.join('');
}

function applySickPreview(sched, requesterId, date) {
  const next = { ...sched };
  const key = `${requesterId}_${date}`;
  next[key] = { ...(next[key] || {}), status: 'sick', shift: next[key]?.shift || 'morning', staff_id: requesterId, date };
  return next;
}

function applyMoveOffPreview(sched, requesterId, originalOffDate, newOffDate, fallbackShift) {
  const next = { ...sched };
  const k1 = `${requesterId}_${originalOffDate}`;
  const k2 = `${requesterId}_${newOffDate}`;
  const orig = next[k1] || { staff_id: requesterId, date: originalOffDate };
  const newRow = next[k2] || { staff_id: requesterId, date: newOffDate };
  next[k1] = { ...orig, status: 'work', shift: fallbackShift || 'morning' };
  next[k2] = { ...newRow, status: 'off' };
  return next;
}

function applyTradePreview(sched, reqId, partnerId, reqDate, partnerDate) {
  const next = { ...sched };
  const k1 = `${reqId}_${reqDate}`;
  const k2 = `${partnerId}_${partnerDate}`;
  const a = next[k1];
  const b = next[k2];
  if (!a || !b) return next;
  next[k1] = { ...a, shift: b.shift };
  next[k2] = { ...b, shift: a.shift };
  return next;
}

async function svgToPng(svg) {
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// Build PNG buffer untuk before/after sick request
export async function renderSickPair(deptId, requesterId, date, deptName) {
  const { staff, dates, sched } = fetchScheduleData(deptId, requesterId, date);
  if (!staff.length) return { before: null, after: null };
  const marked = { [requesterId]: [date] };
  const before = await svgToPng(renderSvg({ staff, dates, sched, marked, title: `BEFORE — ${deptName || 'Schedule'} (${dates[0].slice(0, 7)})`, requesterId }));
  const afterSched = applySickPreview(sched, requesterId, date);
  const after = await svgToPng(renderSvg({ staff, dates, sched: afterSched, marked, title: `AFTER — Sick on ${date}`, requesterId }));
  return { before, after };
}

export async function renderMoveOffPair(deptId, requesterId, originalDate, newDate, fallbackShift, deptName) {
  const m1 = getMonthKey(originalDate);
  const m2 = getMonthKey(newDate);
  const focusDate = originalDate <= newDate ? originalDate : newDate;
  const { staff, dates, sched } = fetchScheduleData(deptId, requesterId, focusDate);
  if (!staff.length) return { before: null, after: null };
  const marked = { [requesterId]: [originalDate, newDate].filter((d) => dates.includes(d)) };
  const before = await svgToPng(renderSvg({ staff, dates, sched, marked, title: `BEFORE — ${deptName || 'Schedule'} (${dates[0].slice(0, 7)})`, requesterId }));
  const afterSched = applyMoveOffPreview(sched, requesterId, originalDate, newDate, fallbackShift);
  const after = await svgToPng(renderSvg({ staff, dates, sched: afterSched, marked, title: `AFTER — Move off ${originalDate} → ${newDate}`, requesterId }));
  // Kalau tanggal di bulan berbeda, render bulan kedua juga
  let beforeWk2 = null, afterWk2 = null;
  if (m1 !== m2) {
    const d2 = fetchScheduleData(deptId, requesterId, originalDate <= newDate ? newDate : originalDate);
    if (d2.staff.length) {
      const marked2 = { [requesterId]: [originalDate, newDate].filter((d) => d2.dates.includes(d)) };
      beforeWk2 = await svgToPng(renderSvg({ staff: d2.staff, dates: d2.dates, sched: d2.sched, marked: marked2, title: `BEFORE — ${d2.dates[0].slice(0, 7)}`, requesterId }));
      const afterSched2 = applyMoveOffPreview(d2.sched, requesterId, originalDate, newDate, fallbackShift);
      afterWk2 = await svgToPng(renderSvg({ staff: d2.staff, dates: d2.dates, sched: afterSched2, marked: marked2, title: `AFTER — ${d2.dates[0].slice(0, 7)}`, requesterId }));
    }
  }
  return { before, after, beforeWk2, afterWk2 };
}

export async function renderTradePair(deptId, requesterId, partnerId, reqDate, partnerDate, deptName) {
  const focusDate = reqDate <= partnerDate ? reqDate : partnerDate;
  const { staff, dates, sched } = fetchScheduleData(deptId, requesterId, focusDate);
  if (!staff.length) return { before: null, after: null };
  const marked = {
    [requesterId]: [reqDate].filter((d) => dates.includes(d)),
    [partnerId]: [partnerDate].filter((d) => dates.includes(d)),
  };
  const before = await svgToPng(renderSvg({ staff, dates, sched, marked, title: `BEFORE — ${deptName || 'Schedule'} (${dates[0].slice(0, 7)})`, requesterId }));
  const afterSched = applyTradePreview(sched, requesterId, partnerId, reqDate, partnerDate);
  const after = await svgToPng(renderSvg({ staff, dates, sched: afterSched, marked, title: `AFTER — Trade ${reqDate} <-> ${partnerDate}`, requesterId }));
  return { before, after };
}
