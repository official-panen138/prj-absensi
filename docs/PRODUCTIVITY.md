# Productivity Calculation

Penjelasan rumus produktivitas, bagaimana data tersimpan, dan cara baca laporan.

## TL;DR

- Setiap clock-out menghitung **score** harian = `expected_work − late − overbreak`
- Total bulanan = **cumulative**: `SUM(score) / SUM(expected) × 100`
- Tidak averaging — hari telat tidak "diencerkan" oleh hari sempurna

## Formula per shift (saat clock-out)

```
expected_work = shift_duration − total_break_quota
                // mis. (22:00−10:00 = 720m) − 60m break = 660m

late_minutes      = att.late_minutes        // dari clock-in
overbreak_minutes = max(0, total_break − break_quota)

productive_score  = max(0, expected_work − late − overbreak)
daily_ratio       = score / expected × 100
```

Yang disimpan ke `attendance` (additive columns):

| Field | Tipe | Diisi saat |
|---|---|---|
| `expected_work_minutes` | INTEGER | clock-out |
| `productive_score` | INTEGER | clock-out |
| `overbreak_minutes` | INTEGER | clock-out |
| `productive_ratio` | REAL | clock-out (existing, dipakai sebagai daily%) |

## Aggregate bulanan (Reports)

```sql
SELECT
  SUM(expected_work_minutes) AS total_expected,
  SUM(productive_score)      AS total_score,
  SUM(late_minutes)          AS total_late,
  SUM(overbreak_minutes)     AS total_overbreak
FROM attendance
WHERE staff_id = ? AND date BETWEEN ? AND ?
```

Lalu di backend:

```js
cumulative_ratio = total_score / total_expected × 100
```

Per-staff baseline expected = `expected_work × jumlah hari kerja`. Staff yang
libur 4 hari vs 5 hari otomatis punya baseline berbeda.

## Komponen baseline

`expected_work` per shift dihitung dari:

- `shift_duration` = `getEffectiveShiftTime(tenantId, deptId, shiftName)` — pakai
  override per-dept jika ada, jatuh ke tenant default
- `break_quota` = SUM dari semua tipe break (smoke + toilet + outside) yang
  berlaku untuk dept tersebut

Cross-midnight (mis. Night 22:00→10:00) di-handle: kalau `end_time <= start_time`,
ditambah 24 jam.

## Skenario contoh

Marcel — 30 hari (kerja 26, libur 4), shift 12h, expected 660m/hari → total
expected 17.160m/bulan.

| Hari | Late | Overbreak | Score | Cum Score / Exp | Cum % |
|---|---|---|---|---|---|
| 1 | 0 | 0 | 660 | 660 / 660 | 100.0 |
| 2 | 20 | 20 | 620 | 1280 / 1320 | 96.97 |
| 3 | 15 | 10 | 635 | 1915 / 1980 | 96.72 |
| 4 | 0 | 5 | 655 | 2570 / 2640 | 97.35 |
| 5 | 30 | 0 | 630 | 3200 / 3300 | 96.97 |
| ... | | | | | |
| 26 | (akumulasi) | | | ~16800 / 17160 | ~97.9 |

## Perbandingan vs formula lama

Formula lama: `workMin / totalMin × 100` — clock-out cepat 1 jam tanpa break
hasil 100%. Formula baru: 60 / 660 = ~9% (mencerminkan bahwa staff cuma
menyentuh 9% dari ekspektasi shift). Detail lengkap di
[`PRODUCTIVITY_PROPOSAL.pdf`](./PRODUCTIVITY_PROPOSAL.pdf).

## Endpoint API

### `GET /api/reports/productivity/:ym`

Aggregate bulanan, sorted by `cumulative_productive_ratio DESC`.

Response item:

```json
{
  "staff_id": 12,
  "name": "Marcel",
  "department": "SEO Marketing",
  "current_shift": "morning",
  "days_worked": 26,
  "total_late_minutes": 320,
  "total_overbreak_minutes": 280,
  "total_expected_minutes": 17160,
  "total_productive_score": 16560,
  "cumulative_productive_ratio": 96.5
}
```

### `GET /api/reports/productivity-detail/:staffId/:ym`

Per-day breakdown untuk 1 staff. Termasuk schedule status (work/off/sick/leave),
clock in/out, late, overbreak, score, dan running cumulative %.

```json
{
  "staff": { "id": 12, "name": "Marcel", "department": "SEO Marketing" },
  "range": { "start": "2026-04-01", "end": "2026-04-30" },
  "summary": {
    "work_days": 26, "off_days": 4,
    "total_expected_minutes": 17160,
    "total_productive_score": 16560,
    "cumulative_ratio": 96.5
  },
  "days": [
    {
      "date": "2026-04-01",
      "sched_status": "work",
      "shift": "morning",
      "clock_in": "...", "clock_out": "...",
      "late_minutes": 0, "overbreak_minutes": 0,
      "expected_minutes": 660, "score": 660,
      "daily_ratio": 100, "cumulative_ratio": 100
    },
    ...
  ]
}
```

## UI

**Reports → Productivity** (table):

| # | Name | Dept | Shift | Days | Productive | Expected (m) | Late (m) | Overbreak (m) | Score (m) | Aksi |
|---|---|---|---|---|---|---|---|---|---|---|

- Klik **nama staff** → modal detail per-hari (ProductivityDetail)
- Tombol **↺ Reset** (admin) → hapus attendance + break_log staff dalam range periode
- Tombol **↺ Reset All** (admin, di toolbar) → wipe semua staff dalam range

## Migration / backfill

Field baru ditambahkan via additive `ALTER TABLE`:

```sql
ALTER TABLE attendance ADD COLUMN expected_work_minutes INTEGER DEFAULT 0;
ALTER TABLE attendance ADD COLUMN productive_score INTEGER DEFAULT 0;
ALTER TABLE attendance ADD COLUMN overbreak_minutes INTEGER DEFAULT 0;
```

Data existing akan punya `expected_work_minutes = 0` → `cumulative_ratio = 0%`.
Ada 2 cara untuk fix:

1. **Reset** data lama via tombol di UI (paling aman untuk testing).
2. **Backfill script** (belum ada) — perlu dibuat kalau ingin recompute data
   produksi lama berdasarkan shift_times saat ini.

## Edge cases

| Kasus | Behavior |
|---|---|
| Hari OFF | Tidak masuk perhitungan (expected = 0, skip) |
| Hari SICK / LEAVE | Sama — skip dari baseline |
| Belum clock-out | `productive_score` & `expected_work_minutes` masih 0 sampai clock-out |
| Shift cross-midnight | Duration = end + 24h kalau end ≤ start |
| Break < quota | `overbreak_minutes` = 0, tidak ada bonus untuk efisien |
| Staff baru tengah bulan | Baseline ikut menyesuaikan — hanya hitung hari yang ada |
