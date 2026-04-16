import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { shiftBgClass } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge } from '../components/ui';

export default function SwapRequestsPage({ token }) {
  const [swaps, setSwaps] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState('pending');

  const fetchSwaps = useCallback(async () => {
    setLoading(true);
    try {
      const pending = await apiFetch(token, '/swap/pending');
      setSwaps(pending.data || []);
      const all = await apiFetch(token, '/swap/history');
      setHistory(all.data || []);
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchSwaps(); }, [fetchSwaps]);

  const approveSwap = async (id) => { try { await apiFetch(token, `/swap/${id}/approve`, { method: 'PUT' }); setToast({ type: 'ok', text: 'Swap approved!' }); fetchSwaps(); } catch (e) { setToast({ type: 'error', text: e.message }); } };
  const rejectSwap = async (id) => { const reason = window.prompt('Rejection reason (optional):'); try { await apiFetch(token, `/swap/${id}/reject`, { method: 'PUT', body: { reject_reason: reason || '' } }); setToast({ type: 'ok', text: 'Swap rejected.' }); fetchSwaps(); } catch (e) { setToast({ type: 'error', text: e.message }); } };

  const data = tab === 'pending' ? swaps : history;
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-5">
        <h1 className="text-xl lg:text-2xl font-extrabold">Swap Requests</h1>
        <div className="flex gap-2">
          <Btn size="sm" variant={tab === 'pending' ? 'primary' : 'ghost'} onClick={() => setTab('pending')}>Pending {swaps.length > 0 && `(${swaps.length})`}</Btn>
          <Btn size="sm" variant={tab === 'history' ? 'primary' : 'ghost'} onClick={() => setTab('history')}>History</Btn>
          <Btn size="sm" variant="ghost" onClick={fetchSwaps}>↻</Btn>
        </div>
      </div>

      {loading ? <div className="flex justify-center p-16"><Spinner /></div>
      : data.length === 0 ? <Card className="p-10 text-center text-gray-500">{tab === 'pending' ? 'No pending swap requests.' : 'No swap history.'}</Card>
      : <>
        {/* Desktop Table */}
        <Card className="overflow-x-auto hidden md:block">
          <table className="w-full border-collapse text-xs">
            <thead><tr className="bg-gray-800">{['Staff', 'Dept', 'Date', 'Current Shift', 'Reason', 'Status', 'Requested', 'Actions'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id} className="border-b border-gray-800">
                  <td className={tdCls}>{s.requester_name}</td>
                  <td className={`${tdCls} text-gray-400`}>{s.requester_dept || '—'}</td>
                  <td className={`${tdCls} font-mono text-[11px]`}>{s.target_date}</td>
                  <td className={tdCls}><Badge color={s.current_shift === 'morning' ? 'green' : s.current_shift === 'middle' ? 'yellow' : 'purple'}>{s.current_shift}</Badge></td>
                  <td className={`${tdCls} max-w-[200px] truncate`}>{s.reason || '—'}</td>
                  <td className={tdCls}><Badge color={s.status === 'approved' ? 'green' : s.status === 'rejected' ? 'red' : 'yellow'}>{s.status}</Badge></td>
                  <td className={`${tdCls} text-[11px] text-gray-500`}>{new Date(s.created_at).toLocaleDateString()}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    {s.status === 'pending' ? <><Btn size="sm" variant="success" onClick={() => approveSwap(s.id)} className="mr-1.5">✓</Btn><Btn size="sm" variant="danger" onClick={() => rejectSwap(s.id)}>✗</Btn></> : <span className="text-gray-500 text-[11px]">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {/* Mobile Cards */}
        <div className="md:hidden grid gap-2">
          {data.map((s) => (
            <Card key={s.id} className="p-3">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <div className="font-bold text-sm">{s.requester_name}</div>
                  <div className="text-[11px] text-gray-500">{s.requester_dept || '—'}</div>
                </div>
                <Badge color={s.status === 'approved' ? 'green' : s.status === 'rejected' ? 'red' : 'yellow'}>{s.status}</Badge>
              </div>
              <div className="flex flex-wrap gap-1.5 mb-2 text-xs text-gray-400">
                <span className="font-mono">{s.target_date}</span>
                <Badge color={s.current_shift === 'morning' ? 'green' : s.current_shift === 'middle' ? 'yellow' : 'purple'}>{s.current_shift}</Badge>
              </div>
              {s.reason && <div className="text-xs text-gray-400 mb-2 truncate">{s.reason}</div>}
              {s.status === 'pending' && (
                <div className="flex gap-1.5">
                  <Btn size="sm" variant="success" onClick={() => approveSwap(s.id)}>✓ Approve</Btn>
                  <Btn size="sm" variant="danger" onClick={() => rejectSwap(s.id)}>✗ Reject</Btn>
                </div>
              )}
            </Card>
          ))}
        </div>
      </>}
    </div>
  );
}
