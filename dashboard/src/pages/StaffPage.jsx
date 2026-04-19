import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { shiftBgClass, DEPARTMENTS as DEPARTMENTS_FALLBACK } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge, Modal, FormRow, SectionHeader } from '../components/ui';

export default function StaffPage({ token }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [filters, setFilters] = useState({ shift: '', category: '', department: '' });
  const [deptInput, setDeptInput] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState([]);

  useEffect(() => {
    apiFetch(token, '/departments').then((r) => setDepartments(r.data || [])).catch(() => {});
  }, [token]);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.shift) params.set('shift', filters.shift);
      if (filters.category) params.set('category', filters.category);
      if (filters.department) params.set('department', filters.department);
      const data = await apiFetch(token, `/staff?${params}`);
      setStaff(data.data || []);
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token, filters]);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);
  useEffect(() => { const t = setTimeout(() => setFilters((f) => ({ ...f, department: deptInput })), 400); return () => clearTimeout(t); }, [deptInput]);

  const openAdd = () => { setForm({ name: '', category: 'indonesian', current_shift: 'morning', department: '', phone: '', telegram_id: '', telegram_username: '' }); setModal('add'); };
  const openEdit = (s) => { setForm({ ...s }); setModal(s); };

  const save = async () => {
    setSaving(true);
    try {
      if (modal === 'add') { await apiFetch(token, '/staff', { method: 'POST', body: form }); setToast({ type: 'ok', text: 'Staff added!' }); }
      else { await apiFetch(token, `/staff/${modal.id}`, { method: 'PUT', body: form }); setToast({ type: 'ok', text: 'Staff updated!' }); }
      setModal(null); fetchStaff();
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setSaving(false); }
  };

  // STEP 2: Quick shift change
  const quickShiftChange = async (staffId, newShift) => {
    try {
      await apiFetch(token, `/staff/${staffId}`, { method: 'PUT', body: { current_shift: newShift } });
      setToast({ type: 'ok', text: 'Shift updated!' });
      setStaff(prev => prev.map(s => s.id === staffId ? { ...s, current_shift: newShift } : s));
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const approveStaff = async (id) => { try { await apiFetch(token, `/staff/${id}/approve`, { method: 'PUT' }); setToast({ type: 'ok', text: 'Staff approved!' }); fetchStaff(); } catch (e) { setToast({ type: 'error', text: e.message }); } };
  const deactivate = async (id, name, isActive) => { const action = isActive ? 'Deactivate' : 'Reactivate'; if (!window.confirm(action + ' ' + name + '?')) return; try { const res = await apiFetch(token, `/staff/${id}`, { method: 'DELETE' }); setToast({ type: 'ok', text: res.message || `${name} updated.` }); fetchStaff(); } catch (e) { setToast({ type: 'error', text: e.message }); } };
  const deleteStaff = async (id, name) => { if (!window.confirm('Permanently delete ' + name + '? This cannot be undone.')) return; if (!window.confirm('FINAL WARNING: All records for ' + name + ' will be deleted. Continue?')) return; try { await apiFetch(token, `/staff/${id}/permanent`, { method: 'DELETE' }); setToast({ type: 'ok', text: `${name} permanently deleted.` }); fetchStaff(); } catch (e) { setToast({ type: 'error', text: e.message }); } };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors';
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';
  const shiftSelectCls = 'text-[11px] px-1.5 py-1 bg-gray-800 border border-gray-700 rounded outline-none focus:border-emerald-500 cursor-pointer';

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <SectionHeader title="Staff Management" actions={<Btn size="sm" onClick={openAdd}>+ Add Staff</Btn>} />

      {/* Filters */}
      <Card className="px-4 py-3 mb-4 flex flex-wrap gap-3 items-center">
        <select className={`${inputCls} w-[140px]`} value={filters.shift} onChange={(e) => setFilters((f) => ({ ...f, shift: e.target.value }))}>
          <option value="">All Shifts</option><option value="morning">Morning</option><option value="middle">Middle</option><option value="night">Night</option>
        </select>
        <select className={`${inputCls} w-[150px]`} value={filters.category} onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value }))}>
          <option value="">All Categories</option><option value="indonesian">Indonesian</option><option value="local">Cambodian</option>
        </select>
        <input className={`${inputCls} w-[160px]`} placeholder="Filter department..." value={deptInput} onChange={(e) => setDeptInput(e.target.value)} />
        <span className="text-xs text-gray-500 ml-auto">{staff.length} staff</span>
      </Card>

      {/* Desktop Table */}
      <Card className="overflow-auto hidden md:block">
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <table className="w-full border-collapse text-xs">
            <thead><tr className="bg-gray-800">{['Name', 'Kategori', 'Shift', 'Dept', 'Phone', 'Status', 'Approved', 'Aksi'].map((h) => <th key={h} className={thCls}>{h}</th>)}</tr></thead>
            <tbody>
              {staff.map((s) => (
                <tr key={s.id} className="border-b border-gray-800 hover:bg-gray-800/50 transition-colors">
                  <td className={`${tdCls} font-semibold`}>{s.name}{s.telegram_username && <div className="text-[10px] text-gray-500">@{s.telegram_username}</div>}</td>
                  <td className={tdCls}><Badge color={s.category === 'indonesian' ? 'emerald' : 'purple'}>{s.category === 'indonesian' ? 'Indonesian' : 'Cambodian'}</Badge></td>
                  <td className={tdCls}>
                    <select
                      value={s.current_shift}
                      onChange={(e) => quickShiftChange(s.id, e.target.value)}
                      className={`${shiftSelectCls} ${s.current_shift === 'morning' ? 'text-emerald-400' : s.current_shift === 'middle' ? 'text-yellow-400' : 'text-purple-400'}`}
                    >
                      <option value="morning">Morning</option>
                      <option value="middle">Middle</option>
                      <option value="night">Night</option>
                    </select>
                  </td>
                  <td className={`${tdCls} text-gray-400`}>{s.department || '—'}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-gray-400`}>{s.phone || '—'}</td>
                  <td className={tdCls}><Badge color={s.is_active ? 'green' : 'red'}>{s.is_active ? 'Active' : 'Inactive'}</Badge></td>
                  <td className={tdCls}>{s.is_approved ? <Badge color="green">✓</Badge> : <Btn size="sm" variant="warning" onClick={() => approveStaff(s.id)}>Approve</Btn>}</td>
                  <td className={`${tdCls} whitespace-nowrap`}>
                    <Btn size="sm" variant="ghost" onClick={() => openEdit(s)}>✏️</Btn>{' '}
                    <Btn size="sm" variant="ghost" className="text-amber-400 border-amber-400/30" onClick={() => deactivate(s.id, s.name, s.is_active)}>{s.is_active ? '⏸' : '▶'}</Btn>{' '}
                    <Btn size="sm" variant="ghost" className="text-red-400 border-red-400/30" onClick={() => deleteStaff(s.id, s.name)}>🗑</Btn>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* Mobile Cards */}
      <div className="md:hidden">
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <div className="grid gap-2">
            {staff.map((s) => (
              <Card key={s.id} className="p-3">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <div className="font-bold text-sm">{s.name}</div>
                    <div className="text-[11px] text-gray-500">{s.department || '—'} {s.telegram_username && `· @${s.telegram_username}`}</div>
                  </div>
                  <div className="flex gap-1">
                    <Badge color={s.is_active ? 'green' : 'red'}>{s.is_active ? 'Active' : 'Inactive'}</Badge>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <Badge color={s.category === 'indonesian' ? 'emerald' : 'purple'}>{s.category === 'indonesian' ? 'Indo' : 'Khmer'}</Badge>
                  <select
                    value={s.current_shift}
                    onChange={(e) => quickShiftChange(s.id, e.target.value)}
                    className={`${shiftSelectCls} ${s.current_shift === 'morning' ? 'text-emerald-400' : s.current_shift === 'middle' ? 'text-yellow-400' : 'text-purple-400'}`}
                  >
                    <option value="morning">Morning</option>
                    <option value="middle">Middle</option>
                    <option value="night">Night</option>
                  </select>
                  {!s.is_approved && <Btn size="sm" variant="warning" onClick={() => approveStaff(s.id)}>Approve</Btn>}
                </div>
                <div className="flex gap-1.5">
                  <Btn size="sm" variant="ghost" onClick={() => openEdit(s)}>✏️ Edit</Btn>
                  <Btn size="sm" variant="ghost" className="text-amber-400 border-amber-400/30" onClick={() => deactivate(s.id, s.name, s.is_active)}>{s.is_active ? '⏸' : '▶'}</Btn>
                  <Btn size="sm" variant="ghost" className="text-red-400 border-red-400/30" onClick={() => deleteStaff(s.id, s.name)}>🗑</Btn>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Add/Edit Modal */}
      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'Add Staff' : 'Edit Staff'} width="max-w-xl">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <FormRow label="NAME"><input className={inputCls} value={form.name || ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></FormRow>
          <FormRow label="CATEGORY"><select className={inputCls} value={form.category || 'indonesian'} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}><option value="indonesian">Indonesian</option><option value="local">Cambodian</option></select></FormRow>
          <FormRow label="DEFAULT SHIFT" note="hanya dipakai kalau tidak ada jadwal untuk hari itu — jadwal di Schedule Calendar selalu prioritas"><select className={inputCls} value={form.current_shift || 'morning'} onChange={(e) => setForm((f) => ({ ...f, current_shift: e.target.value }))}><option value="morning">Morning</option><option value="middle">Middle</option><option value="night">Night</option></select></FormRow>
          <FormRow label="DEPARTMENT" note={departments.length ? `${departments.length} department di tenant ini` : 'Tambah di menu Departments'}>
            <select className={inputCls} value={form.department_id || ''} onChange={(e) => {
              const id = e.target.value ? +e.target.value : null;
              const d = departments.find((x) => x.id === id);
              setForm((f) => ({ ...f, department_id: id, department: d?.name || '' }));
            }}>
              <option value="">— Select —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              {/* Fallback kalau belum ada dept di DB */}
              {!departments.length && DEPARTMENTS_FALLBACK.map((d) => <option key={d} value={`legacy:${d}`}>{d} (legacy)</option>)}
            </select>
          </FormRow>
          <FormRow label="PHONE"><input className={inputCls} value={form.phone || ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} placeholder="+62..." /></FormRow>
          <FormRow label="TELEGRAM ID"><input className={inputCls} value={form.telegram_id || ''} onChange={(e) => setForm((f) => ({ ...f, telegram_id: e.target.value }))} placeholder="123456789" /></FormRow>
          <FormRow label="TELEGRAM USERNAME"><input className={inputCls} value={form.telegram_username || ''} onChange={(e) => setForm((f) => ({ ...f, telegram_username: e.target.value }))} placeholder="@username" /></FormRow>
          <FormRow label="JOIN DATE"><input type="date" className={inputCls} value={form.join_date?.split('T')[0] || ''} onChange={(e) => setForm((f) => ({ ...f, join_date: e.target.value }))} /></FormRow>
        </div>
        <div className="flex gap-2 justify-end mt-1"><Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn><Btn onClick={save} disabled={saving}>{saving ? <Spinner /> : (modal === 'add' ? 'Add Staff' : 'Save')}</Btn></div>
      </Modal>
    </div>
  );
}
