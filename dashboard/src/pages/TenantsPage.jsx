import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { Card, Spinner, Toast, Btn, Badge, Modal, FormRow, SectionHeader } from '../components/ui';

export default function TenantsPage({ token }) {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ slug: '', name: '' });
  const [saving, setSaving] = useState(false);

  const fetchTenants = useCallback(async () => {
    setLoading(true);
    try { const r = await apiFetch(token, '/tenants'); setTenants(r.data || []); }
    catch (e) { setToast({ type: 'error', text: e.message }); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchTenants(); }, [fetchTenants]);

  const openAdd = () => { setForm({ slug: '', name: '' }); setModal('add'); };
  const openEdit = (t) => { setForm({ slug: t.slug, name: t.name, id: t.id }); setModal(t); };

  const save = async () => {
    setSaving(true);
    try {
      if (modal === 'add') {
        await apiFetch(token, '/tenants', { method: 'POST', body: { slug: form.slug, name: form.name } });
        setToast({ type: 'ok', text: 'Tenant created!' });
      } else {
        await apiFetch(token, `/tenants/${modal.id}`, { method: 'PUT', body: { name: form.name } });
        setToast({ type: 'ok', text: 'Tenant updated!' });
      }
      setModal(null); fetchTenants();
    } catch (e) { setToast({ type: 'error', text: e.message }); }
    finally { setSaving(false); }
  };

  const deleteTenant = async (t) => {
    if (!window.confirm(`Hapus tenant "${t.name}"? Hanya bisa kalau tidak ada staff.`)) return;
    try {
      await apiFetch(token, `/tenants/${t.id}`, { method: 'DELETE' });
      setToast({ type: 'ok', text: 'Tenant deleted.' }); fetchTenants();
    } catch (e) { setToast({ type: 'error', text: e.message }); }
  };

  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors';
  const thCls = 'px-3 py-2.5 text-left font-bold text-[11px] text-gray-500 whitespace-nowrap tracking-wide border-b border-gray-700';
  const tdCls = 'px-3 py-2.5 text-gray-100';

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <SectionHeader title="🏢 Tenants" actions={<Btn size="sm" onClick={openAdd}>+ New Tenant</Btn>} />

      <Card className="overflow-auto mt-4">
        {loading ? <div className="flex justify-center p-10"><Spinner /></div> : (
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="bg-gray-800">
                {['ID', 'Slug', 'Name', 'Created', 'Aksi'].map((h) => <th key={h} className={thCls}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr key={t.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                  <td className={`${tdCls} font-mono text-gray-500`}>{t.id}</td>
                  <td className={tdCls}><Badge color="purple">{t.slug}</Badge></td>
                  <td className={`${tdCls} font-semibold`}>{t.name}</td>
                  <td className={`${tdCls} text-[11px] text-gray-500`}>{t.created_at ? new Date(t.created_at).toLocaleDateString() : '—'}</td>
                  <td className={tdCls}>
                    <Btn size="sm" variant="ghost" onClick={() => openEdit(t)}>✏️</Btn>{' '}
                    <Btn size="sm" variant="ghost" className="text-red-400 border-red-400/30" onClick={() => deleteTenant(t)}>🗑</Btn>
                  </td>
                </tr>
              ))}
              {tenants.length === 0 && <tr><td colSpan={5} className={`${tdCls} text-center text-gray-500 py-10`}>Belum ada tenant.</td></tr>}
            </tbody>
          </table>
        )}
      </Card>

      <Modal open={!!modal} onClose={() => setModal(null)} title={modal === 'add' ? 'New Tenant' : 'Edit Tenant'}>
        <FormRow label="SLUG" note="identifier unik, huruf kecil, tanpa spasi (cth: panengroup)">
          <input className={inputCls} value={form.slug} disabled={modal !== 'add'} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))} placeholder="panengroup" />
        </FormRow>
        <FormRow label="NAME" note="nama tampil">
          <input className={inputCls} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Panen Group" />
        </FormRow>
        <div className="flex gap-2 justify-end">
          <Btn variant="ghost" onClick={() => setModal(null)}>Cancel</Btn>
          <Btn onClick={save} disabled={saving || !form.slug || !form.name}>{saving ? <Spinner /> : (modal === 'add' ? 'Create' : 'Save')}</Btn>
        </div>
      </Modal>
    </div>
  );
}
