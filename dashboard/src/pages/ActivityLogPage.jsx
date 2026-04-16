import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { todayISO, fmtTime, STATUS_LABEL, BREAK_TYPE_LABEL } from '../lib/theme';
import { Card, Spinner, Toast, Btn } from '../components/ui';

export default function ActivityLogPage({ token }) {
  const [date, setDate] = useState(todayISO());
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [toast, setToast] = useState(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try { const data = await apiFetch(token, `/activity/log/${date}`); setLogs(data.data || []); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token, date]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);

  const events = [];
  logs.forEach((log) => {
    if (log.clock_in) events.push({ time: log.clock_in, staff: log.name, dept: log.department, event: 'START', detail: `Shift: ${log.shift}${log.late_minutes > 0 ? ` · Late ${log.late_minutes}m` : ''}`, ip: log.ip_address, color: 'text-emerald-400', icon: '▶️' });
    (log.breaks || []).forEach((b) => {
      events.push({ time: b.start_time, staff: log.name, dept: log.department, event: 'break-start', detail: `${BREAK_TYPE_LABEL[b.type] || b.type} started`, ip: '', color: 'text-yellow-400', icon: '⏸' });
      if (b.end_time) events.push({ time: b.end_time, staff: log.name, dept: log.department, event: 'break-end', detail: `${BREAK_TYPE_LABEL[b.type] || b.type} ended — ${b.duration_minutes}m${b.is_overtime ? ' ⚠️ OVERTIME' : ''}`, ip: '', color: b.is_overtime ? 'text-red-400' : 'text-emerald-400', icon: '▶' });
    });
    if (log.clock_out) events.push({ time: log.clock_out, staff: log.name, dept: log.department, event: 'END', detail: `Productivity: ${log.productive_ratio}%`, ip: log.ip_address, color: 'text-red-400', icon: '⏹' });
  });
  events.sort((a, b) => new Date(b.time) - new Date(a.time));
  const filtered = events.filter((e) => !filter || e.staff.toLowerCase().includes(filter.toLowerCase()) || e.dept?.toLowerCase().includes(filter.toLowerCase()));

  const inputCls = 'bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors';
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-5">
        <h1 className="text-xl lg:text-2xl font-extrabold">Activity Log</h1>
        <div className="flex flex-wrap gap-2.5 items-center">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${inputCls} w-[160px]`} />
          <input placeholder="Filter name/dept..." value={filter} onChange={(e) => setFilter(e.target.value)} className={`${inputCls} w-[200px]`} />
          <Btn size="sm" variant="ghost" onClick={fetchLogs}>↻</Btn>
        </div>
      </div>

      <div className="text-xs text-gray-500 mb-3">{filtered.length} events — {date}</div>

      {loading ? <div className="flex justify-center p-16"><Spinner /></div> : <>
        {/* Desktop Table */}
        <Card className="overflow-auto hidden md:block">
          <table className="w-full border-collapse text-xs">
            <thead><tr className="bg-gray-800">{['Waktu', 'Staff', 'Event', 'Detail', 'IP'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr></thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={i} className="border-b border-gray-800">
                  <td className={`${tdCls} font-mono text-gray-400 whitespace-nowrap`}>{fmtTime(e.time)}</td>
                  <td className={`${tdCls} font-semibold`}>{e.staff}<div className="text-[10px] text-gray-500">{e.dept}</div></td>
                  <td className={tdCls}><span className={`${e.color} font-semibold`}>{e.icon} {e.event}</span></td>
                  <td className={`${tdCls} text-gray-400`}>{e.detail}</td>
                  <td className={`${tdCls} font-mono text-[10px] text-gray-500`}>{e.ip || '—'}</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={5} className={`${tdCls} text-center text-gray-500 py-10`}>No activity found.</td></tr>}
            </tbody>
          </table>
        </Card>

        {/* Mobile Cards */}
        <div className="md:hidden grid gap-2">
          {filtered.length === 0 ? <Card className="p-10 text-center text-gray-500">No activity found.</Card> :
          filtered.map((e, i) => (
            <Card key={i} className="p-3">
              <div className="flex justify-between items-start mb-1">
                <span className={`${e.color} font-semibold text-xs`}>{e.icon} {e.event}</span>
                <span className="text-[10px] text-gray-500 font-mono">{fmtTime(e.time)}</span>
              </div>
              <div className="font-semibold text-sm">{e.staff}</div>
              <div className="text-[11px] text-gray-400">{e.detail}</div>
            </Card>
          ))}
        </div>
      </>}
    </div>
  );
}
