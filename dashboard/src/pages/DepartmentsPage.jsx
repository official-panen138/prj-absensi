import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { Card, Spinner, Toast, Btn, Badge, Modal, FormRow, SectionHeader } from '../components/ui';

export default function DepartmentsPage({ token }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);

  const fetchDepts = useCallback(async () => {
    setLoading(true);
    try { const r = await apiFetch(token, '/departments'); setItems(r.data || []); }
    catch (e) { setToast({ type: 'error', text: e.message }); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchDepts(); }, [fetchDepts]);

  const openAdd = () => { setForm({ name: '', head_telegram_id: '', head_username: '', monitor_group_chat_id: '' }); setModal('add'); };
  const openEdit = (d) => { setForm({ ...d }); setModal(d); };

  const save = async () => {
    setSaving(true);
    try {
      if (modal === 'add') {
        await apiFetch(token, '/departments', { method: 'POST', body: form });
        setToast({ type: 'ok', text: 'Department created!' });
      } else {
        await apiFetch(token, `/departments/${modal.id}`, { method: 'PUT', body: form });
        setToast({ type: 'ok', text: 'Department updated!' });
      }
      setModal(null); fetchDepts();
    } catch (e) { setToast({ type: 'error', text: e.message }); }
    finally { setSaving(false); }
  };

  const del = async (d) => {
    if (!window.confirm(`Hapus department "${d.name}"? Hanya bisa kalau tidak ada staff.`)) return;
    try {
      await apiFetch(token, `/departments/${d.id}`, { method: 'DELETE' });
      setToast({ type: 'ok', text: 'Deleted.' }); fetchDepts();
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors';
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <SectionHeader title="🏬 Departments" actions={<Btn size="sm" onClick={openAdd}>+ New Department</Btn>} />

      <Card className="overflow-auto mt-4">
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-800">
                {['Name', 'Slug', 'Head TG ID', 'Head Username', 'Group Chat ID', 'Staff', 'Aksi'].map((h) => <th key={h} className={thCls}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className={`${tdCls} font-semibold`}>{d.name}</td>
                  <td className={`${tdCls} font-mono text-[11px] text-gray-400`}>{d.slug || '—'}</td>
                  <td className={`${tdCls} font-mono text-[11px]`}>{d.head_telegram_id || <span className="text-gray-500">—</span>}</td>
                  <td className={`${tdCls} font-mono text-[11px]`}>{d.head_username ? `@${d.head_username}` : <span className="text-gray-500">—</span>}</td>
                  <td className={`${tdCls} font-mono text-[11px]`}>{d.monitor_group_chat_id || <span className="text-gray-500">tenant default</span>}</td>
                  <td className={tdCls}><Badge color="emerald">{d.staff_count || 0}</Badge></td>
                  <td className={tdCls}>
                    <Btn size="sm" variant="ghost" onClick={() => openEdit(d)}>✏️</Btn>{' '}
                    <Btn size="sm" variant="ghost" className="text-red-400 border-red-400/30" onClick={() => del(d)}>🗑</Btn>
                  </td>
                </tr>
              ))}
              {items.length === 0 && <tr><td colSpan={7} className={`${tdCls} text-center text-gray-500 py-10`}>Belum ada department.</td></tr>}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'New Department' : 'Edit Department'} width="max-w-2xl">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4">
          <FormRow label="NAME"><input className={inputCls} value={form.name || ''} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Customer Service" /></FormRow>
          <FormRow label="SLUG" note="auto-generate kalau kosong"><input className={inputCls} value={form.slug || ''} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }))} placeholder="customer_service" /></FormRow>
          <FormRow label="HEAD TELEGRAM ID" note="DM @userinfobot untuk dapat ID"><input className={`${inputCls} font-mono`} value={form.head_telegram_id || ''} onChange={(e) => setForm((f) => ({ ...f, head_telegram_id: e.target.value }))} placeholder="123456789" /></FormRow>
          <FormRow label="HEAD USERNAME" note="opsional, untuk display"><input className={inputCls} value={form.head_username || ''} onChange={(e) => setForm((f) => ({ ...f, head_username: e.target.value.replace(/^@/, '') }))} placeholder="kepala_cs" /></FormRow>
          <FormRow label="MONITOR GROUP CHAT ID" note="kosong = pakai tenant default"><input className={`${inputCls} font-mono`} value={form.monitor_group_chat_id || ''} onChange={(e) => setForm((f) => ({ ...f, monitor_group_chat_id: e.target.value }))} placeholder="-1001234567890" /></FormRow>
        </div>
        <div className="flex gap-2 justify-end mt-2">
          <Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving || !form.name}>{saving ? <Spinner /> : (modal === 'add' ? 'Create' : 'Save')}</Btn>
        </div>
      </Modal>
    </div>
  );
}
