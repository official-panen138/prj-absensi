import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch, API_BASE } from '../lib/api';
import { currentYM, todayISO, BREAK_TYPE_LABEL } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge, MonthPicker } from '../components/ui';

function getWeeksOfMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const weeks = [];
  let weekStart = 1;
  while (weekStart <= daysInMonth) {
    const weekEnd = Math.min(weekStart + 6, daysInMonth);
    const from = `${ym}-${String(weekStart).padStart(2, '0')}`;
    const to = `${ym}-${String(weekEnd).padStart(2, '0')}`;
    const label = `${weekStart}-${weekEnd}`;
    weeks.push({ from, to, label });
    weekStart = weekEnd + 1;
  }
  return weeks;
}

export default function ReportsPage({ token }) {
  const [month, setMonth] = useState(currentYM());
  const [period, setPeriod] = useState('monthly'); // daily | weekly | monthly
  const [dailyDate, setDailyDate] = useState(todayISO());
  const [weekIdx, setWeekIdx] = useState(0);
  const [tab, setTab] = useState('summary');
  const [data, setData] = useState({});
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);

  const weeks = useMemo(() => getWeeksOfMonth(month), [month]);

  // Compute from/to based on period
  const { periodFrom, periodTo, periodLabel } = useMemo(() => {
    if (period === 'daily') {
      return { periodFrom: dailyDate, periodTo: dailyDate, periodLabel: dailyDate };
    }
    if (period === 'weekly') {
      const w = weeks[weekIdx] || weeks[0];
      if (!w) return { periodFrom: null, periodTo: null, periodLabel: month };
      return { periodFrom: w.from, periodTo: w.to, periodLabel: `${month}-W${weekIdx + 1}` };
    }
    return { periodFrom: null, periodTo: null, periodLabel: month };
  }, [period, dailyDate, weekIdx, weeks, month]);

  // Reset week index when month changes
  useEffect(() => { setWeekIdx(0); }, [month]);

  // Clamp daily date to selected month
  useEffect(() => {
    if (period === 'daily') {
      const prefix = month; // e.g. "2026-03"
      if (!dailyDate.startsWith(prefix)) {
        setDailyDate(`${month}-01`);
      }
    }
  }, [month, period, dailyDate]);

  const fetchReport = useCallback(async () => {
    setLoading(true);
    try {
      const qs = (periodFrom && periodTo) ? `?from=${periodFrom}&to=${periodTo}` : '';
      const [summary, attendance, violations, productivity] = await Promise.all([
        apiFetch(token, `/reports/monthly/${month}${qs}`),
        apiFetch(token, `/reports/attendance/${month}${qs}`),
        apiFetch(token, `/reports/violations/${month}${qs}`),
        apiFetch(token, `/reports/productivity/${month}${qs}`),
      ]);
      setData({ summary: summary.data, attendance: attendance.data, violations: violations.data, productivity: productivity.data });
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token, month, periodFrom, periodTo]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  const exportXlsx = async () => {
    try {
      const params = new URLSearchParams();
      if (periodFrom) params.set('from', periodFrom);
      if (periodTo) params.set('to', periodTo);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(`${API_BASE}/reports/export/${month}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `workforce-report-${periodLabel}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const TABS = ['summary', 'attendance', 'violations', 'productivity'];
  const tabLabels = { summary: 'Summary', attendance: 'Attendance', violations: 'Violations', productivity: 'Productivity' };
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';

  const periodBtnCls = (p) => `px-3 py-1.5 text-xs font-bold rounded-md border transition-all duration-150 cursor-pointer ${period === p ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40' : 'bg-transparent text-gray-500 border-gray-700 hover:text-gray-300'}`;

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
        <h1 className="text-xl lg:text-2xl font-extrabold">Reports</h1>
        <div className="flex flex-wrap gap-2.5 items-center">
          <MonthPicker value={month} onChange={setMonth} />
          <Btn size="sm" variant="ghost" onClick={fetchReport}>↻</Btn>
          <Btn size="sm" variant="success" onClick={exportXlsx}>Export</Btn>
        </div>
      </div>

      {/* Period selector */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <div className="flex gap-1">
          <button className={periodBtnCls('daily')} onClick={() => setPeriod('daily')}>Daily</button>
          <button className={periodBtnCls('weekly')} onClick={() => setPeriod('weekly')}>Weekly</button>
          <button className={periodBtnCls('monthly')} onClick={() => setPeriod('monthly')}>Monthly</button>
        </div>

        {period === 'daily' && (
          <input
            type="date"
            value={dailyDate}
            onChange={(e) => setDailyDate(e.target.value)}
            className="bg-gray-800 border border-gray-700 text-gray-100 text-xs rounded-md px-2.5 py-1.5 font-mono focus:outline-none focus:border-emerald-500"
          />
        )}

        {period === 'weekly' && weeks.length > 0 && (
          <div className="flex items-center gap-1">
            <button className="px-2 py-1 text-xs bg-transparent border border-gray-700 text-gray-400 rounded cursor-pointer hover:text-gray-200" onClick={() => setWeekIdx(Math.max(0, weekIdx - 1))} disabled={weekIdx === 0}>&lt;</button>
            <span className="font-mono text-xs text-emerald-400 min-w-[110px] text-center">Week {weekIdx + 1}: {weeks[weekIdx]?.label}</span>
            <button className="px-2 py-1 text-xs bg-transparent border border-gray-700 text-gray-400 rounded cursor-pointer hover:text-gray-200" onClick={() => setWeekIdx(Math.min(weeks.length - 1, weekIdx + 1))} disabled={weekIdx >= weeks.length - 1}>&gt;</button>
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-800 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 border-none bg-transparent text-[13px] cursor-pointer whitespace-nowrap transition-all duration-150 ${tab === t ? 'text-emerald-400 font-bold border-b-2 border-emerald-400' : 'text-gray-500 hover:text-gray-300'}`}>
            {tabLabels[t]}
          </button>
        ))}
      </div>

      {loading ? <div className="flex justify-center p-16"><Spinner /></div> : <>
        {tab === 'summary' && <ReportSummary data={data.summary} />}
        {tab === 'attendance' && <ReportTable data={data.attendance} type="attendance" thCls={thCls} tdCls={tdCls} />}
        {tab === 'violations' && <ReportTable data={data.violations} type="violations" thCls={thCls} tdCls={tdCls} />}
        {tab === 'productivity' && <ReportTable data={data.productivity} type="productivity" thCls={thCls} tdCls={tdCls} />}
      </>}
    </div>
  );
}

function ReportSummary({ data }) {
  if (!data) return <Card className="p-10 text-center text-gray-500">No data.</Card>;
  const stats = Array.isArray(data) ? null : data;
  if (stats) return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {[
          { l: 'Total Staff', v: stats.unique_staff || 0, c: 'text-emerald-400' },
          { l: 'Total Records', v: stats.total_records || 0, c: 'text-blue-400' },
          { l: 'Total Work (hrs)', v: Math.round((stats.total_work_minutes || 0) / 60), c: 'text-emerald-400' },
          { l: 'Avg Productivity', v: `${parseFloat(stats.avg_productive_ratio || 0).toFixed(1)}%`, c: 'text-emerald-400' },
        ].map((s) => (
          <Card key={s.l} className="p-4">
            <div className={`text-2xl font-extrabold font-mono ${s.c}`}>{s.v}</div>
            <div className="text-[11px] text-gray-500">{s.l}</div>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {[
          { l: 'Total Break (hrs)', v: Math.round((stats.total_break_minutes || 0) / 60), c: 'text-yellow-400' },
          { l: 'Total Late (m)', v: stats.total_late_minutes || 0, c: 'text-amber-400' },
          { l: 'Break Violations', v: stats.total_break_violations || 0, c: 'text-red-400' },
        ].map((s) => (
          <Card key={s.l} className="p-4">
            <div className={`text-2xl font-extrabold font-mono ${s.c}`}>{s.v}</div>
            <div className="text-[11px] text-gray-500">{s.l}</div>
          </Card>
        ))}
      </div>
    </div>
  );
  if (!data?.length) return <Card className="p-10 text-center text-gray-500">No data.</Card>;
  return <Card className="p-5 text-gray-500">See Attendance tab for details.</Card>;
}

function ReportTable({ data, type, thCls, tdCls }) {
  if (!data?.length) return <Card className={`p-10 text-center ${type === 'violations' ? 'text-emerald-400' : 'text-gray-500'}`}>{type === 'violations' ? 'No violations!' : 'No data.'}</Card>;

  const headers = {
    attendance: ['#', 'Name', 'Dept', 'Shift', 'Present', 'Off', 'Late(m)', 'Work(hrs)', 'Break(hrs)', 'Productive(%)'],
    violations: ['Name', 'Dept', 'Break Type', 'Duration', 'Limit', 'Over(m)', 'Date'],
    productivity: ['#', 'Name', 'Dept', 'Shift', 'Days', 'Avg Productive', 'Avg Work(m)', 'Avg Break(m)', 'OT Breaks'],
  };

  return (
    <Card className="overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead><tr className="bg-gray-800">{(headers[type] || []).map((h) => <th key={h} className={thCls}>{h}</th>)}</tr></thead>
        <tbody>
          {data.map((r, i) => {
            if (type === 'attendance') return (
              <tr key={r.staff_id || i} className="border-b border-gray-800">
                <td className={`${tdCls} text-gray-500`}>{i + 1}</td><td className={`${tdCls} font-semibold`}>{r.name}</td><td className={tdCls}>{r.department}</td>
                <td className={tdCls}><Badge color={r.current_shift === 'morning' ? 'green' : r.current_shift === 'middle' ? 'yellow' : 'purple'}>{r.current_shift}</Badge></td>
                <td className={`${tdCls} text-emerald-400 font-mono`}>{r.days_present || 0}</td>
                <td className={`${tdCls} font-mono`}>{r.days_off || 0}</td>
                <td className={`${tdCls} font-mono ${(parseInt(r.total_late_minutes) || 0) > 0 ? 'text-amber-400' : 'text-gray-400'}`}>{r.total_late_minutes || 0}</td>
                <td className={`${tdCls} font-mono`}>{Math.round((r.total_work_minutes || 0) / 60)}</td>
                <td className={`${tdCls} font-mono`}>{Math.round((r.total_break_minutes || 0) / 60)}</td>
                <td className={`${tdCls} text-emerald-400 font-mono`}>{parseFloat(r.avg_productive_ratio || 0).toFixed(1)}%</td>
              </tr>
            );
            if (type === 'violations') return (
              <tr key={i} className="border-b border-gray-800">
                <td className={`${tdCls} font-semibold`}>{r.name}</td><td className={tdCls}>{r.department}</td>
                <td className={tdCls}>{BREAK_TYPE_LABEL[r.type] || r.type}</td>
                <td className={`${tdCls} text-red-400 font-mono`}>{r.duration_minutes}m</td>
                <td className={`${tdCls} font-mono`}>{r.limit_minutes}m</td>
                <td className={`${tdCls} text-red-400 font-bold font-mono`}>+{(r.duration_minutes || 0) - (r.limit_minutes || 0)}m</td>
                <td className={`${tdCls} font-mono`}>{r.date}</td>
              </tr>
            );
            if (type === 'productivity') {
              const ratio = parseFloat(r.avg_productive_ratio || 0);
              const barC = ratio >= 80 ? 'bg-emerald-400' : ratio >= 60 ? 'bg-yellow-400' : 'bg-red-400';
              const textC = ratio >= 80 ? 'text-emerald-400' : ratio >= 60 ? 'text-yellow-400' : 'text-red-400';
              const dw = parseInt(r.days_worked) || 1;
              return (
                <tr key={r.staff_id || i} className="border-b border-gray-800">
                  <td className={`${tdCls} text-gray-500`}>{i + 1}</td><td className={`${tdCls} font-semibold`}>{r.name}</td><td className={tdCls}>{r.department}</td>
                  <td className={tdCls}><Badge color={r.current_shift === 'morning' ? 'green' : r.current_shift === 'middle' ? 'yellow' : 'purple'}>{r.current_shift}</Badge></td>
                  <td className={tdCls}>{r.days_worked || 0}</td>
                  <td className={tdCls}>
                    <div className="flex items-center gap-1.5">
                      <div className="w-12 h-1 bg-gray-700 rounded-sm overflow-hidden"><div className={`h-full rounded-sm ${barC}`} style={{ width: `${Math.min(100, ratio)}%` }} /></div>
                      <span className={`font-mono ${textC}`}>{ratio.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className={tdCls}>{Math.round((r.total_work_minutes || 0) / dw)}</td>
                  <td className={tdCls}>{Math.round((r.total_break_minutes || 0) / dw)}</td>
                  <td className={`${tdCls} ${(r.overtime_breaks || 0) > 0 ? 'text-red-400' : 'text-gray-500'}`}>{r.overtime_breaks || 0}</td>
                </tr>
              );
            }
            return null;
          })}
        </tbody>
      </table>
    </Card>
  );
}
