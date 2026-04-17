import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch, API_BASE } from '../lib/api';
import { currentYM, todayISO, SCHED_LABEL, shiftColorClass, shiftBgClass, schedBgClass } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge, Modal, FormRow, MonthPicker, SectionHeader } from '../components/ui';
import * as XLSX from 'xlsx';

export default function SchedulePage({ token, user }) {
  const [month, setMonth] = useState(currentYM());
  const [schedule, setSchedule] = useState(null);
  const schedScrollRef = useRef(null);
  const [rotation, setRotation] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [editCell, setEditCell] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [generating, setGenerating] = useState(false);
  const [approving, setApproving] = useState(false);
  const [dayView, setDayView] = useState(null);
  const [dayViewData, setDayViewData] = useState([]);
  const [dayViewSaving, setDayViewSaving] = useState(false);
  const [offDayRules, setOffDayRules] = useState({ max_indo_off_per_shift_per_day: 2, max_local_off_per_shift_per_day: 2 });
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const importRef = useRef(null);

  const fetchSchedule = useCallback(async () => {
    setLoading(true);
    try {
      const [sched, rot] = await Promise.all([apiFetch(token, `/schedule/${month}`), apiFetch(token, `/schedule/rotation/${month}`)]);
      const raw = sched.data;
      if (raw?.daily && !raw.staff_schedules) {
        const grouped = {};
        raw.daily.forEach((d) => { if (!grouped[d.staff_id]) grouped[d.staff_id] = { staff_id: d.staff_id, name: d.name, category: d.category, department: d.department, days: [] }; grouped[d.staff_id].days.push(d); });
        raw.staff_schedules = Object.values(grouped);
      }
      setSchedule(raw);
      setRotation(rot.data || []);
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token, month]);

  useEffect(() => { fetchSchedule(); }, [fetchSchedule]);

  useEffect(() => { (async () => { try { const res = await apiFetch(token, '/settings'); const odr = res.data?.settings?.off_day_rules?.value; if (odr) setOffDayRules((prev) => ({ ...prev, ...odr })); } catch (e) {} })(); }, [token]);

  const generate = async () => {
    if (!window.confirm('Generate schedule will overwrite existing draft. Continue?')) return;
    setGenerating(true);
    try { await apiFetch(token, '/schedule/generate', { method: 'POST', body: { month } }); setToast({ type: 'ok', text: 'Schedule generated!' }); fetchSchedule(); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setGenerating(false); }
  };

  const approve = async () => {
    if (!window.confirm('Approve schedule? This will make it active.')) return;
    setApproving(true);
    try { await apiFetch(token, `/schedule/${month}/approve`, { method: 'PUT' }); setToast({ type: 'ok', text: 'Schedule approved!' }); fetchSchedule(); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setApproving(false); }
  };

  // STEP 4: Copy from last month
  const copyLastMonth = async () => {
    if (!window.confirm('Copy schedule from last month? This will overwrite current draft.')) return;
    setCopying(true);
    try {
      const res = await apiFetch(token, `/schedule/${month}/copy-last-month`, { method: 'POST' });
      setToast({ type: 'ok', text: res.message });
      fetchSchedule();
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setCopying(false); }
  };

  // STEP 1: Import from Excel
  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      if (rows.length < 2) throw new Error('Excel file is empty or has no data rows');

      const header = rows[0];
      // Find date columns: header cells that are numbers (1-31) or date strings
      const dateColStart = header.findIndex((h, i) => i > 0 && /^\d{1,2}$/.test(String(h).trim()));
      if (dateColStart < 0) throw new Error('Cannot find date columns (1,2,3...31) in header row');

      const [y, m] = month.split('-').map(Number);
      const entries = [];
      const shiftMap = { m: 'morning', d: 'middle', n: 'night' };

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const staffName = String(row[0] || '').trim();
        if (!staffName) continue;

        for (let c = dateColStart; c < header.length; c++) {
          const dayNum = parseInt(String(header[c]).trim());
          if (isNaN(dayNum) || dayNum < 1 || dayNum > 31) continue;

          const cellVal = String(row[c] || '').trim().toLowerCase();
          if (!cellVal || cellVal === '-') continue;

          const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
          let status = 'work', shift = 'morning';

          if (['off', 'sick', 'leave'].includes(cellVal)) {
            status = cellVal;
          } else if (cellVal === 'work' || cellVal === 'w') {
            status = 'work';
          } else if (shiftMap[cellVal]) {
            status = 'work';
            shift = shiftMap[cellVal];
          } else if (['morning', 'middle', 'night'].includes(cellVal)) {
            status = 'work';
            shift = cellVal;
          } else if (['s', 'sick'].includes(cellVal)) {
            status = 'sick';
          } else if (['l'].includes(cellVal)) {
            status = 'leave';
          } else {
            continue;
          }

          entries.push({ staff_name: staffName, date: dateStr, status, shift });
        }
      }

      if (entries.length === 0) throw new Error('No valid entries found in Excel file');

      const res = await apiFetch(token, `/schedule/${month}/import`, { method: 'POST', body: { entries } });
      setToast({ type: 'ok', text: res.message });
      if (res.errors?.length) console.warn('Import warnings:', res.errors);
      fetchSchedule();
    } catch (err) { setToast({ type: 'error', text: err.message }); } finally { setImporting(false); }
  };

  const openDayView = (dateStr) => {
    const staffList = schedule?.staff_schedules || [];
    const entries = [];
    staffList.forEach((s) => {
      const dayData = (s.days || []).find((d) => (d.date || '').substring(0, 10) === dateStr);
      entries.push({ staff_id: s.staff_id, name: s.name, category: s.category, department: s.department, id: dayData?.id || null, shift: dayData?.shift || s.days?.[0]?.shift || 'morning', status: dayData?.status || 'work' });
    });
    setDayViewData(entries);
    setDayView(dateStr);
  };

  const saveDayView = async () => {
    setDayViewSaving(true);
    try {
      for (const entry of dayViewData) {
        if (entry.id) {
          await apiFetch(token, `/schedule/daily/${entry.id}`, { method: 'PUT', body: { status: entry.status, shift: entry.shift, is_manual_override: true } });
        } else {
          await apiFetch(token, '/schedule/daily', { method: 'POST', body: { staff_id: entry.staff_id, date: dayView, status: entry.status, shift: entry.shift, is_manual_override: true } });
        }
      }
      setToast({ type: 'ok', text: 'Day view saved!' });
      setDayView(null);
      await fetchSchedule();
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setDayViewSaving(false); }
  };

  const updateDayViewEntry = (staffId, field, value) => {
    setDayViewData((prev) => prev.map((e) => (e.staff_id === staffId ? { ...e, [field]: value } : e)));
  };

  // STEP 5: Bulk toggle department to OFF
  const bulkSetDeptOff = (shift, department) => {
    setDayViewData((prev) => prev.map((e) => {
      if (e.shift === shift && e.department === department) return { ...e, status: 'off' };
      return e;
    }));
  };

  const saveOverride = async () => {
    try {
      const scrollEl = schedScrollRef.current;
      const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
      const scrollLeft = scrollEl ? scrollEl.scrollLeft : 0;
      if (editCell.id) {
        await apiFetch(token, `/schedule/daily/${editCell.id}`, { method: 'PUT', body: editForm });
      } else {
        await apiFetch(token, '/schedule/daily', { method: 'POST', body: { staff_id: editCell.staff_id, date: editCell.date, ...editForm } });
      }
      setToast({ type: 'ok', text: 'Cell updated!' });
      setEditCell(null);
      await fetchSchedule();
      requestAnimationFrame(() => { const el = schedScrollRef.current; if (el) { el.scrollTop = scrollTop; el.scrollLeft = scrollLeft; } });
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const exportXlsx = async () => {
    try {
      const r = await fetch(`${API_BASE}/schedule/${month}/export`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('Export failed');
      const b = await r.blob();
      const u = URL.createObjectURL(b);
      const a = document.createElement('a');
      a.href = u; a.download = `schedule-${month}.xlsx`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(u);
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => {
    const d = new Date(y, m - 1, i + 1);
    return { num: i + 1, dateStr: `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`, dayName: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getDay()], isWeekend: d.getDay() === 0 || d.getDay() === 6 };
  });
  const today = todayISO();
  const schedStatus = schedule?.status;

  const staffList = schedule?.staff_schedules || [];
  let statWork = 0, statOff = 0, statSick = 0, statLeave = 0;
  staffList.forEach((s) => (s.days || []).forEach((d) => { const st = d.status || 'work'; if (st === 'work') statWork++; else if (st === 'off') statOff++; else if (st === 'sick') statSick++; else if (st === 'leave') statLeave++; }));

  // STEP 6: Color coding maps
  const cellColorMap = {
    'work-morning': 'bg-emerald-500/20 text-emerald-400',
    'work-middle': 'bg-blue-500/20 text-blue-400',
    'work-night': 'bg-purple-500/20 text-purple-400',
    'off': 'bg-red-500/20 text-red-400',
    'sick': 'bg-amber-500/20 text-amber-400',
    'leave': 'bg-blue-500/20 text-blue-300',
  };
  const cellLabelMap = { morning: 'M', middle: 'D', night: 'N' };

  const shiftLetterMap = { morning: 'M', middle: 'D', night: 'N' };
  const shiftColorMap = { morning: 'text-emerald-400', middle: 'text-yellow-400', night: 'text-purple-400' };

  // STEP 3: Summary calculations
  const summaryData = (() => {
    if (!staffList.length) return null;
    const shiftCounts = { morning: 0, middle: 0, night: 0 };
    const todayOffs = [];
    const noOffStaff = [];
    const overLimitDays = [];

    // Count per shift (based on staff's most common shift or latest day's shift)
    staffList.forEach(s => {
      const todayEntry = (s.days || []).find(d => (d.date || '').substring(0, 10) === today);
      const shift = todayEntry?.shift || s.days?.[0]?.shift || 'morning';
      if (shiftCounts[shift] !== undefined) shiftCounts[shift]++;

      // Today's offs
      if (todayEntry?.status === 'off') todayOffs.push(s.name);

      // Staff with zero off days this month
      const offCount = (s.days || []).filter(d => d.status === 'off').length;
      if (offCount === 0 && (s.days || []).length > 0) noOffStaff.push(s.name);
    });

    // Over-limit off days per date
    const maxIndo = offDayRules.max_indo_off_per_shift_per_day || 2;
    const maxLocal = offDayRules.max_local_off_per_shift_per_day || 2;

    days.forEach(d => {
      ['morning', 'middle', 'night'].forEach(shift => {
        let indoOff = 0, localOff = 0;
        staffList.forEach(s => {
          const dayData = (s.days || []).find(day => (day.date || '').substring(0, 10) === d.dateStr);
          if (dayData?.shift === shift && dayData?.status === 'off') {
            if (s.category === 'indonesian') indoOff++;
            else localOff++;
          }
        });
        if (indoOff > maxIndo) overLimitDays.push(`${d.num} ${d.dayName}: Indo OFF ${indoOff}/${maxIndo} (${shift})`);
        if (localOff > maxLocal) overLimitDays.push(`${d.num} ${d.dayName}: Khmer OFF ${localOff}/${maxLocal} (${shift})`);
      });
    });

    return { shiftCounts, todayOffs, noOffStaff, overLimitDays };
  })();

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <input ref={importRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={handleImport} />

      {/* Header */}
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3 mb-4">
        <h1 className="text-xl lg:text-2xl font-extrabold">Schedule Calendar</h1>
        <div className="flex flex-wrap gap-2.5 items-center">
          <MonthPicker value={month} onChange={setMonth} />
          {schedStatus && <Badge color={schedStatus === 'approved' ? 'green' : schedStatus === 'draft' ? 'yellow' : 'gray'}>{schedStatus?.toUpperCase()}</Badge>}
          <Btn size="sm" variant="ghost" onClick={() => { setLoading(true); fetchSchedule(); }}>↻</Btn>
          <Btn size="sm" variant="warning" onClick={copyLastMonth} disabled={copying}>{copying ? <Spinner /> : '📋 Copy Last Month'}</Btn>
          <Btn size="sm" variant="warning" onClick={generate} disabled={generating}>{generating ? <Spinner /> : '⚙ Generate'}</Btn>
          {schedStatus === 'draft' && <Btn size="sm" variant="success" onClick={approve} disabled={approving}>{approving ? <Spinner /> : '✓ Approve'}</Btn>}
          {schedule && <Btn size="sm" variant="ghost" onClick={exportXlsx}>📥 Export</Btn>}
          <Btn size="sm" variant="ghost" onClick={() => importRef.current?.click()} disabled={importing}>{importing ? <Spinner /> : '📤 Import'}</Btn>
        </div>
      </div>

      {/* Stats */}
      <div className="flex flex-wrap gap-3 mb-3 text-[11px] text-gray-500">
        <span>{staffList.length} staff × {daysInMonth} days</span>
        <span className="text-emerald-400">Work: {statWork}</span>
        <span className="text-red-400">Off: {statOff}</span>
        <span className="text-yellow-400">Sick: {statSick}</span>
        <span className="text-blue-400">Leave: {statLeave}</span>
      </div>

      {/* STEP 3: Summary Bar */}
      {summaryData && (
        <Card className="mb-3 px-4 py-3">
          <div className="flex items-center justify-between cursor-pointer" onClick={() => setSummaryOpen(o => !o)}>
            <span className="text-xs font-bold text-gray-400">Schedule Summary</span>
            <span className="text-gray-500 text-xs">{summaryOpen ? '▲' : '▼'}</span>
          </div>
          {summaryOpen && (
            <div className="mt-2 space-y-2">
              <div className="flex flex-wrap gap-4 text-xs">
                <span className="text-emerald-400">Morning: {summaryData.shiftCounts.morning}</span>
                <span className="text-yellow-400">Middle: {summaryData.shiftCounts.middle}</span>
                <span className="text-purple-400">Night: {summaryData.shiftCounts.night}</span>
                <span className="text-red-400">Off today: {summaryData.todayOffs.length}</span>
              </div>
              {summaryData.noOffStaff.length > 0 && (
                <div className="text-xs text-amber-400">⚠️ Belum dapat OFF: {summaryData.noOffStaff.join(', ')}</div>
              )}
              {summaryData.overLimitDays.length > 0 && (
                <div className="text-xs text-red-400 space-y-0.5">
                  {summaryData.overLimitDays.map((w, i) => <div key={i}>⚠️ {w}</div>)}
                </div>
              )}
              {summaryData.noOffStaff.length === 0 && summaryData.overLimitDays.length === 0 && (
                <div className="text-xs text-emerald-400">✓ All good — no warnings</div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Grid */}
      {loading ? (
        <div className="flex justify-center p-16"><Spinner /></div>
      ) : !staffList.length ? (
        <Card className="p-10 text-center text-gray-500">No schedule data. Click "Generate" to create.</Card>
      ) : (
        <div ref={schedScrollRef} className="overflow-auto max-h-[calc(100vh-240px)]">
          <Card className="min-w-full">
            <table className="border-collapse text-[11px] min-w-full">
              <thead>
                <tr className="sticky top-0 z-10 bg-gray-800">
                  <th className="sticky left-0 z-20 bg-gray-800 px-2.5 py-2 text-left font-bold text-[11px] text-gray-500 border-b border-r border-gray-700 min-w-[120px]">Staff</th>
                  {days.map((d) => (
                    <th
                      key={d.num}
                      onClick={() => openDayView(d.dateStr)}
                      className={`px-0.5 py-1 text-center font-semibold text-[10px] border-b border-gray-700 min-w-[36px] cursor-pointer hover:bg-emerald-500/10 ${d.dateStr === today ? 'text-emerald-400 bg-emerald-500/10' : d.isWeekend ? 'text-red-400' : 'text-gray-500'}`}
                    >
                      <div>{d.dayName}</div>
                      <div className="font-mono">{d.num}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(() => {
                  const renderStaffRow = (staff) => (
                    <tr key={staff.staff_id}>
                      <td className="sticky left-0 z-[5] bg-gray-900 px-2 py-1 border-b border-r border-gray-700 font-semibold text-[11px] whitespace-nowrap">
                        <div>{staff.name}</div>
                        <div className="text-[9px] text-gray-500">{staff.department || ''}</div>
                      </td>
                      {days.map((d) => {
                        const dayData = (staff.days || []).find((day) => (day.date || '').substring(0, 10) === d.dateStr);
                        const st = dayData?.status || null;
                        const shift = dayData?.shift || null;
                        const isManual = dayData?.is_manual_override;
                        const isEmpty = !dayData;
                        const isToday = d.dateStr === today;
                        let cellColor = '';
                        let cellText = '';
                        if (!isEmpty) {
                          if (st === 'work') {
                            cellColor = cellColorMap[`work-${shift}`] || '';
                            cellText = cellLabelMap[shift] || '';
                          } else if (st === 'off') { cellColor = cellColorMap['off']; cellText = 'OFF'; }
                          else if (st === 'sick') { cellColor = cellColorMap['sick']; cellText = 'S'; }
                          else if (st === 'leave') { cellColor = cellColorMap['leave']; cellText = 'L'; }
                        }
                        return (
                          <td
                            key={d.num}
                            onClick={() => { setEditCell({ id: dayData?.id || null, staff_id: staff.staff_id, staff_name: staff.name, date: d.dateStr, status: st, shift }); setEditForm({ status: st || 'work', shift: shift || 'morning', is_manual_override: true }); }}
                            className={`p-0 border-b border-gray-700 cursor-pointer relative transition-colors duration-150 hover:brightness-125 ${isToday ? 'ring-1 ring-inset ring-emerald-500/40' : ''} ${cellColor} ${isManual ? 'border-l-2 border-l-yellow-400' : ''}`}
                            title={`${staff.name} — ${d.dateStr}: ${st || 'empty'} ${shift || ''}`}
                          >
                            <div className="w-9 h-9 flex items-center justify-center">
                              {isEmpty ? <span className="text-gray-500 text-sm opacity-30">+</span>
                              : <span className="font-bold text-[11px]">{cellText}</span>}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );

                  // Group staff by department
                  const groups = {};
                  staffList.forEach((s) => {
                    const dept = s.department || '(Tanpa Department)';
                    if (!groups[dept]) groups[dept] = [];
                    groups[dept].push(s);
                  });
                  const sortedDepts = Object.keys(groups).sort((a, b) => a.localeCompare(b));
                  const rows = [];
                  sortedDepts.forEach((dept) => {
                    rows.push(
                      <tr key={`dept-${dept}`}>
                        <td colSpan={daysInMonth + 1} className="sticky left-0 z-[6] bg-gray-800/80 border-b border-t border-gray-700 px-2.5 py-1.5">
                          <div className="flex items-center gap-2">
                            <div className="w-1 h-3.5 bg-emerald-400 rounded-sm" />
                            <span className="text-[11px] font-bold text-gray-200 uppercase tracking-wider">{dept}</span>
                            <span className="text-[10px] text-gray-500 font-mono">({groups[dept].length})</span>
                          </div>
                        </td>
                      </tr>
                    );
                    groups[dept].forEach((staff) => {
                      rows.push(renderStaffRow(staff));
                    });
                  });
                  return rows;
                })()}
              </tbody>
            </table>
          </Card>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2.5 text-[11px]">
        {[
          { label: 'Morning (M)', cls: 'bg-emerald-500/20', color: 'text-emerald-400' },
          { label: 'Middle (D)', cls: 'bg-blue-500/20', color: 'text-blue-400' },
          { label: 'Night (N)', cls: 'bg-purple-500/20', color: 'text-purple-400' },
          { label: 'Off', cls: 'bg-red-500/20', color: 'text-red-400' },
          { label: 'Sick (S)', cls: 'bg-amber-500/20', color: 'text-amber-400' },
          { label: 'Leave (L)', cls: 'bg-blue-500/20', color: 'text-blue-300' },
          { label: 'Manual', cls: 'border-l-[3px] border-l-yellow-400', color: 'text-yellow-400' },
        ].map((l) => (
          <div key={l.label} className="flex items-center gap-1">
            <div className={`w-3.5 h-3.5 rounded-sm border border-gray-700 ${l.cls}`} />
            <span className={l.color}>{l.label}</span>
          </div>
        ))}
      </div>

      {/* Edit Cell Modal */}
      <Modal open={!!editCell} onClose={() => setEditCell(null)} title={`${editCell?.staff_name} — ${editCell?.date}`}>
        <FormRow label="STATUS">
          <select className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500" value={editForm.status || 'work'} onChange={(e) => setEditForm((f) => ({ ...f, status: e.target.value }))}>
            <option value="work">Work</option><option value="off">Off</option><option value="sick">Sick</option><option value="leave">Leave</option>
          </select>
        </FormRow>
        <FormRow label="SHIFT">
          <select className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500" value={editForm.shift || 'morning'} onChange={(e) => setEditForm((f) => ({ ...f, shift: e.target.value }))}>
            <option value="morning">Morning</option><option value="middle">Middle</option><option value="night">Night</option>
          </select>
        </FormRow>
        <div className="flex gap-2 justify-end"><Btn variant="ghost" onClick={() => setEditCell(null)}>Cancel</Btn><Btn onClick={saveOverride}>Save</Btn></div>
      </Modal>

      {/* Day View Modal */}
      <Modal open={!!dayView} onClose={() => setDayView(null)} title={`Day View — ${dayView}`} width="max-w-3xl">
        {(() => {
          const shifts = ['morning', 'middle', 'night'];
          const maxIndo = offDayRules.max_indo_off_per_shift_per_day || 2;
          const maxLocal = offDayRules.max_local_off_per_shift_per_day || 2;
          const shiftLabels = { morning: 'Morning', middle: 'Middle', night: 'Night' };
          return (
            <div>
              {shifts.map((shift) => {
                const staffInShift = dayViewData.filter((e) => e.shift === shift);
                const indoOff = staffInShift.filter((e) => e.category === 'indonesian' && e.status === 'off').length;
                const localOff = staffInShift.filter((e) => e.category === 'local' && e.status === 'off').length;
                const indoOver = indoOff > maxIndo;
                const localOver = localOff > maxLocal;

                // STEP 5: Get unique departments in this shift
                const depts = [...new Set(staffInShift.map(e => e.department).filter(Boolean))];

                return (
                  <div key={shift} className="mb-5">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className={`w-[3px] h-4 rounded-sm ${shift === 'morning' ? 'bg-emerald-400' : shift === 'middle' ? 'bg-yellow-400' : 'bg-purple-400'}`} />
                        <span className={`font-bold text-sm ${shiftColorMap[shift]}`}>{shiftLabels[shift]}</span>
                        <span className="text-[11px] text-gray-500">({staffInShift.length} staff)</span>
                      </div>
                      <div className="flex gap-3 text-[11px]">
                        <span className={`${indoOver ? 'text-red-400 font-bold' : 'text-gray-400'}`}>Indo OFF: {indoOff}/{maxIndo}</span>
                        <span className={`${localOver ? 'text-red-400 font-bold' : 'text-gray-400'}`}>Khmer OFF: {localOff}/{maxLocal}</span>
                      </div>
                    </div>

                    {/* STEP 5: Bulk department toggle */}
                    {depts.length > 0 && (
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[10px] text-gray-500">Set all</span>
                        <select
                          className="text-[11px] px-1.5 py-0.5 bg-gray-800 border border-gray-700 rounded text-gray-100 outline-none"
                          defaultValue=""
                          onChange={(e) => { if (e.target.value) { bulkSetDeptOff(shift, e.target.value); e.target.value = ''; } }}
                        >
                          <option value="" disabled>dept → OFF</option>
                          {depts.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </div>
                    )}

                    {staffInShift.length === 0 ? (
                      <div className="text-xs text-gray-500 py-2">No staff on this shift.</div>
                    ) : (
                      <div className="grid gap-1">
                        {staffInShift.map((entry) => (
                          <div key={entry.staff_id} className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border ${entry.status === 'off' ? 'bg-red-500/10 border-red-500/30' : 'bg-gray-800 border-gray-700'}`}>
                            <span className="text-xs w-4">{entry.category === 'indonesian' ? '🇮🇩' : '🇰🇭'}</span>
                            <span className="flex-1 text-xs font-semibold">{entry.name}</span>
                            <span className="text-[10px] text-gray-500 w-20 hidden sm:block">{entry.department || '—'}</span>
                            <select value={entry.shift} onChange={(e) => updateDayViewEntry(entry.staff_id, 'shift', e.target.value)} className="w-[90px] text-[11px] px-1.5 py-1 bg-gray-800 border border-gray-700 rounded text-gray-100 outline-none focus:border-emerald-500">
                              <option value="morning">Morning</option><option value="middle">Middle</option><option value="night">Night</option>
                            </select>
                            <select value={entry.status} onChange={(e) => updateDayViewEntry(entry.staff_id, 'status', e.target.value)} className={`w-20 text-[11px] px-1.5 py-1 bg-gray-800 border border-gray-700 rounded outline-none focus:border-emerald-500 ${entry.status === 'off' ? 'text-red-400' : entry.status === 'work' ? 'text-emerald-400' : 'text-gray-100'}`}>
                              <option value="work">Work</option><option value="off">Off</option><option value="sick">Sick</option><option value="leave">Leave</option>
                            </select>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="flex gap-2 justify-end mt-3 border-t border-gray-800 pt-3">
                <Btn variant="ghost" onClick={() => setDayView(null)}>Cancel</Btn>
                <Btn onClick={saveDayView} disabled={dayViewSaving}>{dayViewSaving ? <Spinner /> : 'Save Day View'}</Btn>
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
