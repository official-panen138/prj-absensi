// Generate PDF proposal: Old vs New Productivity Formula
// Run: cd backend && node scripts/gen-productivity-proposal.js
import PDFDocument from 'pdfkit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', '..', 'docs');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'PRODUCTIVITY_PROPOSAL.pdf');

const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
  Title: 'Productivity Formula Proposal',
  Author: 'Absen System',
  Subject: 'Comparison: old simple ratio vs new cumulative formula',
}});
doc.pipe(fs.createWriteStream(outPath));

const C = {
  primary: '#10b981',
  red: '#dc2626',
  amber: '#d97706',
  text: '#111827',
  muted: '#6b7280',
  bg: '#f3f4f6',
};

// === HEADER ===
doc.fillColor(C.primary).fontSize(22).font('Helvetica-Bold').text('Proposal: Formula Productivity Baru', { align: 'center' });
doc.moveDown(0.3);
doc.fillColor(C.muted).fontSize(10).font('Helvetica').text('Absen Workforce Management — comparison rumus lama vs baru', { align: 'center' });
doc.moveDown(0.2);
doc.fillColor(C.muted).fontSize(9).text(new Date().toISOString().slice(0, 10), { align: 'center' });
doc.moveDown(1.5);

// === EXECUTIVE SUMMARY ===
doc.fillColor(C.text).fontSize(14).font('Helvetica-Bold').text('Ringkasan Eksekutif');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica').text(
  'Rumus produktivitas lama hanya membandingkan waktu kerja vs total durasi di kantor — sehingga staff yang clock-out cepat tetap dapat 100%. ' +
  'Rumus baru menggunakan baseline jam kerja seharusnya per shift (expected work) sebagai pembagi, ' +
  'lalu mengurangi penalti telat & overbreak. Akumulasi bulanan = total score / total expected.',
  { align: 'justify' }
);
doc.moveDown(1);

// === FORMULA LAMA ===
doc.fillColor(C.red).fontSize(13).font('Helvetica-Bold').text('1. Formula Lama (sebelum update)');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica');
doc.text('Per shift (saat clock-out):');
doc.moveDown(0.2);
doc.font('Courier').fontSize(9).fillColor(C.muted)
  .text('  totalMin   = clock_out - clock_in     (durasi total di kantor)')
  .text('  breakMin   = total_break_minutes')
  .text('  workMin    = max(0, totalMin - breakMin)')
  .text('  productive = workMin / totalMin × 100');
doc.moveDown(0.4);
doc.font('Helvetica').fontSize(10).fillColor(C.text);
doc.text('Aggregate bulanan: AVG(productive_ratio) — rata-rata sederhana semua hari.');
doc.moveDown(0.5);

doc.fillColor(C.red).fontSize(11).font('Helvetica-Bold').text('Kelemahan:');
doc.fillColor(C.text).fontSize(10).font('Helvetica');
const oldFlaws = [
  'Clock-out cepat 1 jam tanpa break tetap 100% (60/60).',
  'Telat 2 jam tidak kena penalti kalau staff tidak break.',
  'Tidak compare ke jadwal shift — kerja 6 jam dari shift 12 jam masih bisa 100%.',
  'Break overtime (lewat limit) dihitung normal, tidak ada pinalti khusus.',
];
oldFlaws.forEach((f) => doc.text('  • ' + f));
doc.moveDown(1);

// === FORMULA BARU ===
doc.fillColor(C.primary).fontSize(13).font('Helvetica-Bold').text('2. Formula Baru (cumulative)');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica').text('Per shift (saat clock-out):');
doc.moveDown(0.2);
doc.font('Courier').fontSize(9).fillColor(C.muted)
  .text('  expected_work = shift_duration - break_quota')
  .text('                  // contoh: (22:00-10:00 = 720m) - 60m break = 660m')
  .text('  late_minutes      = att.late_minutes')
  .text('  overbreak_minutes = max(0, total_break - break_quota)')
  .text('')
  .text('  productive_score  = max(0, expected_work - late - overbreak)')
  .text('  daily_ratio       = score / expected × 100');
doc.moveDown(0.4);
doc.font('Helvetica').fontSize(10).fillColor(C.text);
doc.text('Aggregate bulanan (cumulative):');
doc.moveDown(0.2);
doc.font('Courier').fontSize(9).fillColor(C.muted)
  .text('  total_expected = SUM(expected_work_minutes)   // mis. 660 × 26 = 17.160')
  .text('  total_score    = SUM(productive_score)')
  .text('  cumulative_ratio = total_score / total_expected × 100');
doc.moveDown(0.5);

doc.fillColor(C.primary).fontSize(11).font('Helvetica-Bold').text('Keunggulan:');
doc.fillColor(C.text).fontSize(10).font('Helvetica');
const newWins = [
  'Baseline jelas dari shift_times → tergantung dept & shift.',
  'Cumulative — tidak averaging, jadi 1 hari telat tidak "diencerkan" oleh hari lain.',
  'Telat & overbreak langsung kena penalti (kurangi score).',
  'Per-staff variable: kalau jadwal libur 4 hari atau 5 hari, expected total ikut menyesuaikan.',
];
newWins.forEach((w) => doc.text('  • ' + w));
doc.moveDown(1);

// === EXAMPLE ===
doc.addPage();
doc.fillColor(C.text).fontSize(14).font('Helvetica-Bold').text('3. Contoh Perhitungan');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica').text(
  'Skenario: Marcel — 30 hari (kerja 26 hari, libur 4 hari). Shift 12 jam (660m efektif). ' +
  'Total expected bulanan = 660 × 26 = 17.160 menit.'
);
doc.moveDown(0.5);

const tableX = 50;
const colW = [50, 50, 80, 80, 100, 80];
const headers = ['Hari', 'Late', 'Overbreak', 'Score Hari', 'Cum Score / Exp', 'Cum %'];
let y = doc.y;

// table header
doc.rect(tableX, y, colW.reduce((a, b) => a + b), 22).fill(C.primary);
doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
let x = tableX;
headers.forEach((h, i) => { doc.text(h, x + 5, y + 7, { width: colW[i] - 10 }); x += colW[i]; });
y += 22;

// rows
const rows = [
  ['1', '0', '0', '660', '660 / 660', '100.0'],
  ['2', '20', '20', '620', '1280 / 1320', '96.97'],
  ['3', '15', '10', '635', '1915 / 1980', '96.72'],
  ['4', '0', '5', '655', '2570 / 2640', '97.35'],
  ['5', '30', '0', '630', '3200 / 3300', '96.97'],
  ['...', '...', '...', '...', '...', '...'],
  ['26', '—', '—', '—', '~16800 / 17160', '~97.9'],
];
doc.font('Helvetica').fontSize(9).fillColor(C.text);
rows.forEach((r, ri) => {
  if (ri % 2 === 0) doc.rect(tableX, y, colW.reduce((a, b) => a + b), 18).fillColor('#f9fafb').fill();
  doc.fillColor(C.text);
  let x = tableX;
  r.forEach((cell, i) => { doc.text(cell, x + 5, y + 5, { width: colW[i] - 10 }); x += colW[i]; });
  y += 18;
});

doc.y = y + 20;
doc.fillColor(C.muted).fontSize(9).font('Helvetica').text(
  'Catatan: hari libur tidak masuk ke perhitungan (expected = 0). Sakit & cuti juga skip. ' +
  'Final cumulative% Marcel akan ~97-98% kalau pelanggaran tetap minor seperti contoh.'
);
doc.moveDown(1);

// === COMPARISON TABLE ===
doc.fillColor(C.text).fontSize(13).font('Helvetica-Bold').text('4. Perbandingan Hasil per Skenario');
doc.moveDown(0.4);

const compHeaders = ['Skenario', 'Lama', 'Baru', 'Ideal'];
const compColW = [220, 80, 80, 80];
y = doc.y;
doc.rect(tableX, y, compColW.reduce((a, b) => a + b), 22).fill(C.primary);
doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
x = tableX;
compHeaders.forEach((h, i) => { doc.text(h, x + 5, y + 7, { width: compColW[i] - 10 }); x += compColW[i]; });
y += 22;

const compRows = [
  ['Full shift, no break, on-time', '100%', '100%', '100%'],
  ['Clock-out 1 jam, no break', '100% ✗', '9% ✓', '~10%'],
  ['Telat 2 jam, work 10h, no break', '100% ✗', '73% ✓', '~80%'],
  ['Break 90m (lewat 30m), full shift', '~95% ✗', '95% ✓', '~95%'],
  ['Shift 12h, kerja 6h, break 0', '100% ✗', '50% ✓', '50%'],
];
doc.font('Helvetica').fontSize(9);
compRows.forEach((r, ri) => {
  if (ri % 2 === 0) doc.rect(tableX, y, compColW.reduce((a, b) => a + b), 18).fillColor('#f9fafb').fill();
  let x = tableX;
  r.forEach((cell, i) => {
    let color = C.text;
    if (cell.includes('✗')) color = C.red;
    else if (cell.includes('✓')) color = C.primary;
    doc.fillColor(color).text(cell, x + 5, y + 5, { width: compColW[i] - 10 });
    x += compColW[i];
  });
  y += 18;
});

doc.y = y + 20;

// === FIELDS DB ===
doc.fillColor(C.text).fontSize(13).font('Helvetica-Bold').text('5. Field Database Baru (additive)');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica').text('Ditambahkan ke tabel attendance:');
doc.moveDown(0.2);
doc.font('Courier').fontSize(9).fillColor(C.muted)
  .text('  expected_work_minutes   INTEGER  -- baseline kerja efektif per shift')
  .text('  productive_score        INTEGER  -- expected - late - overbreak')
  .text('  overbreak_minutes       INTEGER  -- penalti break melebihi quota');
doc.moveDown(0.5);
doc.font('Helvetica').fontSize(10).fillColor(C.text).text(
  'Field lama (productive_ratio, total_work_minutes, total_break_minutes) tetap dipertahankan untuk backward compatibility.'
);
doc.moveDown(1);

// === MIGRATION & ROLLOUT ===
doc.fillColor(C.text).fontSize(13).font('Helvetica-Bold').text('6. Rollout Plan');
doc.moveDown(0.3);
doc.fillColor(C.text).fontSize(10).font('Helvetica');
const steps = [
  '1. DB migration additive — tidak menghapus data lama.',
  '2. Clock-out endpoint compute & store field baru otomatis untuk attendance baru.',
  '3. Reports → query SUM cumulative untuk hitung ratio bulanan.',
  '4. UI Reports → tab Productivity tampilkan kolom Expected, Late, Overbreak, Score.',
  '5. Click nama staff → modal detail per-hari (date, clock-in/out, late, score, cum %).',
  '6. Data lama: tampil 0% di kolom baru (karena expected_work_minutes = 0). Solusi: Reset via tombol "↺ Reset" atau backfill via script.',
];
steps.forEach((s) => { doc.text(s); doc.moveDown(0.15); });
doc.moveDown(0.5);

doc.fillColor(C.amber).fontSize(11).font('Helvetica-Bold').text('Catatan Backfill:');
doc.fillColor(C.text).fontSize(10).font('Helvetica').text(
  'Jika diperlukan, dapat dibuat script backfill yang membaca shift_times saat ini lalu menghitung ' +
  'ulang expected_work_minutes & productive_score untuk semua attendance lama. Saat ini belum ada — ' +
  'data lama tampil 0% sampai di-reset atau di-backfill.'
);
doc.moveDown(1);

// === FOOTER ===
doc.fillColor(C.muted).fontSize(8).font('Helvetica').text(
  'Generated by gen-productivity-proposal.js — Absen Workforce Management',
  50, doc.page.height - 50,
  { align: 'center', width: doc.page.width - 100 }
);

doc.end();
console.log(`✓ PDF generated: ${outPath}`);
