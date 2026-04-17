import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { STATUS_LABEL, BREAK_TYPE_LABEL, fmtTime, statusColor, statusColorHex } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge } from '../components/ui';
import QRMonitorSection from './QRMonitorSection';

export default function LiveBoardPage({ token }) {
  const [data, setData] = useState([]);
  const [breaks, setBreaks] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [forceLoading, setForceLoading] = useState(null);
  const [activeFilter, setActiveFilter] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  const fetchLive = useCallback(async () => {
    try {
      const res = await apiFetch(token, '/activity/live');
      const d = res.data || {};
      setData(d.staff || []);
      setBreaks(d.active_breaks || []);
      setStats(d.stats || null);
    } catch (e) {
      setToast({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchLive();
    const iv = setInterval(fetchLive, 30000);
    return () => clearInterval(iv);
  }, [fetchLive]);

  const forceClockOut = async (staff) => {
    if (!window.confirm('Force END ' + staff.name + '?')) return;
    setForceLoading(staff.id);
    try {
      await apiFetch(token, '/activity/force-clockout', { method: 'POST', body: { staff_id: staff.id, reason: 'Admin force END' } });
      setToast({ type: 'ok', text: `${staff.name} session ended.` });
      fetchLive();
    } catch (e) {
      setToast({ type: 'error', text: e.message });
    } finally {
      setForceLoading(null);
    }
  };

  const online = data.filter((s) => s.clock_in && !s.clock_out);
  const workingList = online.filter((s) => s.current_status === 'working');
  const breakList = online.filter((s) => ['smoking', 'toilet', 'outside'].includes(s.current_status));
  const offList = data.filter((s) => s.schedule_status === 'off');
  const absentList = data.filter((s) => !s.clock_in && (!s.schedule_status || s.schedule_status === 'work'));

  const summary = { total: data.length, online: online.length, working: workingList.length, onBreak: breakList.length, off: offList.length, absent: absentList.length };

  const toggleFilter = (f) => setActiveFilter((prev) => (prev === f ? null : f));

  const filteredData = (() => {
    if (!activeFilter) return data;
    switch (activeFilter) {
      case 'all': return data;
      case 'online': return online;
      case 'working': return workingList;
      case 'break': return breakList;
      case 'off': return offList;
      case 'absent': return absentList;
      default: return data;
    }
  })();

  const filterLabel = activeFilter ? { all: 'All Staff', online: 'Online', working: 'Working', break: 'On Break', off: 'Off Today', absent: 'Absent' }[activeFilter] : null;

  const statCards = [
    { key: 'all', label: 'Total Staff', val: summary.total, color: 'emerald' },
    { key: 'online', label: 'Online', val: summary.online, color: 'green' },
    { key: 'working', label: 'Working', val: summary.working, color: 'green' },
    { key: 'break', label: 'On Break', val: summary.onBreak, color: 'orange' },
    { key: 'off', label: 'Off Today', val: summary.off, color: 'blue' },
    { key: 'absent', label: 'Absent', val: summary.absent, color: 'red' },
  ];

  const colorMap = { emerald: 'text-emerald-400', green: 'text-emerald-400', orange: 'text-amber-400', blue: 'text-blue-400', red: 'text-red-400' };
  const borderColorMap = { emerald: 'border-emerald-400', green: 'border-emerald-400', orange: 'border-amber-400', blue: 'border-blue-400', red: 'border-red-400' };

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-5">
        <h1 className="text-xl lg:text-2xl font-extrabold">Live Board</h1>
        <div className="flex gap-2 items-center">
          {stats && <span className="text-[11px] text-gray-500 font-mono">Shift: {stats.current_shift}</span>}
          <Btn size="sm" variant="ghost" onClick={() => { setLoading(true); fetchLive(); }}>↻</Btn>
        </div>
      </div>

      {/* Stats Bar */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2.5 mb-4">
        {statCards.map((s) => {
          const isActive = activeFilter === s.key;
          return (
            <Card key={s.key} className={`p-3 cursor-pointer transition-all duration-200 relative ${isActive ? `${borderColorMap[s.color]} shadow-lg` : ''}`} glow={isActive}>
              <div onClick={() => toggleFilter(s.key)} className="select-none">
                <div className={`text-xl lg:text-2xl font-extrabold font-mono ${colorMap[s.color]}`}>{s.val}</div>
                <div className={`text-[10px] ${isActive ? colorMap[s.color] + ' font-bold' : 'text-gray-500'}`}>{s.label}</div>
                {isActive && <div className={`absolute top-1 right-2 text-[9px] font-bold ${colorMap[s.color]}`}>✕</div>}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Filter indicator */}
      {activeFilter && (
        <div className="flex items-center gap-2 mb-3 text-xs">
          <span className="text-gray-500">Showing:</span>
          <Badge color="emerald">{filterLabel} ({filteredData.length})</Badge>
          <button onClick={() => setActiveFilter(null)} className="bg-transparent border border-gray-700 rounded px-2 py-0.5 text-gray-500 text-[11px] cursor-pointer hover:text-gray-300">Clear filter</button>
        </div>
      )}

      {/* QR Monitor */}
      <QRMonitorSection token={token} />

      {/* Active Breaks */}
      {breaks.length > 0 && (
        <Card className="px-4 py-3 mb-4 border-amber-400/20">
          <div className="text-[11px] font-bold text-amber-400 mb-2">⏱ ACTIVE BREAKS ({breaks.length})</div>
          <div className="flex flex-wrap gap-2">
            {breaks.map((b) => {
              const elapsedSec = Math.max(0, Math.floor((now - new Date(b.start_time).getTime()) / 1000));
              const elapsed = Math.floor(elapsedSec / 60);
              const over = elapsed >= (b.limit_minutes || 15);
              return (
                <div key={b.id} className={`px-2.5 py-1 bg-gray-800 rounded-md border text-xs ${over ? 'border-red-500/50' : 'border-gray-700'}`}>
                  <strong>{b.name}</strong>{' '}
                  <span className="text-gray-400">{BREAK_TYPE_LABEL[b.type] || b.type}</span>{' '}
                  <span className={`font-mono ${over ? 'text-red-400' : 'text-yellow-400'}`}>{elapsed}m {String(elapsedSec % 60).padStart(2, '0')}s / {b.limit_minutes}m</span>
                  {over && <span className="text-red-400"> 🔴</span>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Staff Cards (grouped by department) */}
      {loading ? (
        <div className="flex justify-center p-16"><Spinner /></div>
      ) : filteredData.length === 0 ? (
        <Card className="p-10 text-center text-gray-500">{activeFilter ? `No staff matching "${filterLabel}".` : 'No staff data.'}</Card>
      ) : (() => {
        // Group by department
        const groups = {};
        filteredData.forEach((s) => {
          const dept = s.department || '(Tanpa Department)';
          if (!groups[dept]) groups[dept] = [];
          groups[dept].push(s);
        });
        const sortedDepts = Object.keys(groups).sort((a, b) => a.localeCompare(b));

        return (
          <div className="flex flex-col gap-5">
            {sortedDepts.map((dept) => {
              const list = groups[dept];
              const onlineCount = list.filter((s) => s.clock_in && !s.clock_out).length;
              return (
                <div key={dept}>
                  <div className="flex items-center gap-2 mb-2.5 px-1">
                    <div className="w-1 h-5 bg-emerald-400 rounded-sm" />
                    <h2 className="text-[13px] font-bold text-gray-200 uppercase tracking-wider">{dept}</h2>
                    <span className="text-[11px] text-gray-500 font-mono">
                      {list.length} staff · {onlineCount} online
                    </span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
                    {list.map((staff) => {
                      const isOnline = staff.clock_in && !staff.clock_out;
                      const sc = statusColor(staff.current_status);
                      const scHex = statusColorHex(staff.current_status);
                      const breakElapsedSec = staff.break_start ? Math.max(0, Math.floor((now - new Date(staff.break_start).getTime()) / 1000)) : 0;
                      const breakElapsed = Math.floor(breakElapsedSec / 60);
                      const breakElapsedLabel = `${breakElapsed}m ${String(breakElapsedSec % 60).padStart(2, '0')}s`;
                      const breakOver = staff.break_limit && breakElapsed >= staff.break_limit;
                      return (
                        <Card key={staff.id} className={`p-3.5 transition-all duration-200 ${isOnline ? (breakOver ? 'border-red-500/20' : '') : 'opacity-50'}`}>
                          <div className="flex justify-between items-start mb-2">
                            <div>
                              <div className="font-bold text-[13px]">{staff.name}</div>
                              <div className="text-[11px] text-gray-500">{staff.department}</div>
                            </div>
                            <div className="flex flex-col items-end gap-1">
                              {isOnline && <div className="w-2 h-2 rounded-full pulse-dot" style={{ color: scHex, backgroundColor: scHex }} />}
                              {breakOver && <span className="text-[10px] text-red-400 font-bold">OVERTIME</span>}
                            </div>
                          </div>
                          <div className={`text-xs font-semibold mb-1.5 ${sc}`}>{isOnline ? (STATUS_LABEL[staff.current_status] || staff.current_status) : '⭘ Not Started'}</div>
                          {staff.break_start && staff.current_status !== 'working' && isOnline && (
                            <div className="mb-1.5">
                              <div className={`bg-gray-800 rounded px-2 py-1 text-[11px] font-mono ${breakOver ? 'text-red-400' : 'text-yellow-400'}`}>⏱ {breakElapsedLabel} / {staff.break_limit}m</div>
                              <div className="h-[3px] bg-gray-700 rounded-sm mt-1 overflow-hidden">
                                <div className={`h-full rounded-sm transition-all duration-500 ${breakOver ? 'bg-red-400' : 'bg-yellow-400'}`} style={{ width: `${Math.min(100, (breakElapsedSec / ((staff.break_limit || 1) * 60)) * 100)}%` }} />
                              </div>
                            </div>
                          )}
                          <div className="flex justify-between items-center">
                            <Badge color={staff.category === 'indonesian' ? 'emerald' : 'purple'}>{staff.category === 'indonesian' ? 'Indonesian' : 'Cambodian'}</Badge>
                            <div className="text-[10px] text-gray-500 font-mono">
                              {isOnline && <>▶ {fmtTime(staff.clock_in)}{staff.late_minutes > 0 && <span className="text-red-400"> +{staff.late_minutes}m</span>}</>}
                            </div>
                          </div>
                          {staff.break_quotas && (
                            <div className="flex gap-2 mt-1.5 text-[10px] font-mono">
                              {['smoke', 'toilet', 'outside'].map((t) => {
                                const q = staff.break_quotas[t];
                                if (!q) return null;
                                const icons = { smoke: '🚬', toilet: '🚻', outside: '🏪' };
                                const exhausted = q.remaining <= 0;
                                const warn = q.used >= q.limit * 0.8;
                                return (
                                  <span key={t} className={exhausted ? 'text-red-400 font-bold' : warn ? 'text-amber-400' : 'text-gray-500'}>
                                    {icons[t]} {q.used}/{q.limit}m
                                  </span>
                                );
                              })}
                            </div>
                          )}
                          {isOnline && (
                            <button
                              onClick={() => forceClockOut(staff)}
                              disabled={forceLoading === staff.id}
                              className={`mt-2.5 w-full py-1 rounded-md bg-transparent border border-red-500/30 text-red-400 text-[11px] cursor-pointer transition-all duration-150 hover:bg-red-500/10 ${forceLoading === staff.id ? 'opacity-50 cursor-not-allowed' : ''}`}
                            >
                              {forceLoading === staff.id ? '⏳ Processing...' : 'Force END'}
                            </button>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}
