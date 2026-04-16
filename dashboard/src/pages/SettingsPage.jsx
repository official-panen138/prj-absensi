import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../lib/api';
import { BREAK_TYPE_LABEL } from '../lib/theme';
import { Card, Spinner, Toast, Btn, Badge, FormRow, SectionHeader } from '../components/ui';

const DEFAULT_BREAK_SETTINGS = { smoke: { daily_quota_minutes: 20 }, toilet: { daily_quota_minutes: 30 }, outside: { daily_quota_minutes: 10 } };
const DEFAULT_SHIFT_TIMES = { morning: { start: '09:00', end: '21:00' }, middle: { start: '14:00', end: '02:00' }, night: { start: '21:00', end: '09:00' } };

export default function SettingsPage({ token, user }) {
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [saving, setSaving] = useState({});
  const [breakForm, setBreakForm] = useState(DEFAULT_BREAK_SETTINGS);
  const [shiftForm, setShiftForm] = useState(DEFAULT_SHIFT_TIMES);
  const [ipForm, setIpForm] = useState({ prefixes: ['45.16.18.', '', '', '', ''] });
  const [offDayForm, setOffDayForm] = useState({ per_person_per_month: 4, max_indo_off_per_shift_per_day: 1, max_local_off_per_shift_per_day: 1 });
  const [tgForm, setTgForm] = useState({ admin_chat_ids: [] });
  const [tgInput, setTgInput] = useState('');
  const [mutedNotifs, setMutedNotifs] = useState([]);
  const [qrRequired, setQrRequired] = useState(false);
  const [workstations, setWorkstations] = useState([]);
  const [wsForm, setWsForm] = useState({ name: '', department: '' });
  const [graceForm, setGraceForm] = useState(5);
  const [pinForm, setPinForm] = useState('');
  const [showPin, setShowPin] = useState(false);

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch(token, '/settings');
      const d = data.data || {};
      const s = d.settings || {};
      const bs = {};
      (d.break_settings || []).forEach((b) => { if (['smoke', 'toilet', 'outside'].includes(b.type)) bs[b.type] = { daily_quota_minutes: b.daily_quota_minutes }; });
      if (Object.keys(bs).length) setBreakForm((prev) => ({ ...prev, ...bs }));
      const sm = {};
      (d.shifts || []).forEach((s) => { sm[s.name] = { start: s.start_time?.substring(0, 5), end: s.end_time?.substring(0, 5) }; });
      if (Object.keys(sm).length) setShiftForm((prev) => ({ ...prev, ...sm }));
      const ip = s.ip_whitelist?.value;
      if (ip?.prefixes) { const arr = [...ip.prefixes]; while (arr.length < 5) arr.push(''); setIpForm({ prefixes: arr.slice(0, 5) }); } else if (ip?.prefix) { setIpForm({ prefixes: [ip.prefix, '', '', '', ''] }); }
      const odr = s.off_day_rules?.value; if (odr) setOffDayForm((prev) => ({ ...prev, ...odr }));
      const tg = s.telegram_admin_chat_ids?.value; if (Array.isArray(tg)) setTgForm({ admin_chat_ids: tg });
      const np = s.notification_prefs?.value; if (np?.muted_types && Array.isArray(np.muted_types)) setMutedNotifs(np.muted_types);
      const qr = s.qr_required?.value; setQrRequired(qr === true || qr === 'true');
      const grace = s.late_grace_minutes?.value; if (grace !== undefined) setGraceForm(typeof grace === 'string' ? parseInt(grace) : (typeof grace === 'number' ? grace : 5));
      const pin = s.registration_pin?.value; if (pin) setPinForm(typeof pin === 'string' ? pin : String(pin));
      try { const wsRes = await apiFetch(token, '/settings/workstations'); setWorkstations(wsRes.data || []); } catch (e) {}
    } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { fetchSettings(); }, [fetchSettings]);

  const save = async (key, path, body) => { setSaving((s) => ({ ...s, [key]: true })); try { await apiFetch(token, path, { method: 'PUT', body }); setToast({ type: 'ok', text: 'Settings saved!' }); fetchSettings(); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setSaving((s) => ({ ...s, [key]: false })); } };
  const isAdmin = user?.role === 'admin';
  const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors';

  if (loading) return <div className="flex justify-center p-16"><Spinner /></div>;

  const shiftColorMap = { morning: 'text-emerald-400', middle: 'text-yellow-400', night: 'text-purple-400' };
  const shiftIcons = { morning: '☀️ Morning', middle: '🌤️ Middle', night: '🌙 Night' };

  const NOTIF_TYPES = [
    { key: 'late', label: '🕐 Late Alerts', desc: 'Staff starting late' },
    { key: 'absent', label: '🚫 Absent Alerts', desc: 'Staff not starting' },
    { key: 'break_start', label: '🚬 Break Start', desc: 'Staff starting a break' },
    { key: 'back_to_work', label: '💻 Back to Work', desc: 'Staff returning from break' },
    { key: 'break_overtime', label: '⏰ Break Overtime', desc: 'Break exceeding limit' },
    { key: 'outside_ip_attempt', label: '📍 IP Warnings', desc: 'START from wrong IP' },
    { key: 'shift_swap', label: '🔄 Swap Requests', desc: 'New swap requests' },
    { key: 'new_registration', label: '🆕 New Registration', desc: 'New staff signed up' },
    { key: 'daily_summary', label: '📊 Daily Summary', desc: 'End-of-shift summary' },
  ];

  return (
    <div className="p-4 lg:p-6 overflow-y-auto h-full animate-fade-in">
      <Toast msg={toast} onClose={() => setToast(null)} />
      <h1 className="text-xl lg:text-2xl font-extrabold mb-5">Settings</h1>
      {!isAdmin && <div className="px-4 py-2.5 bg-yellow-500/15 border border-yellow-500/30 rounded-lg text-yellow-400 text-[13px] mb-5">⚠️ Only Admin can change settings.</div>}

      {/* Late Grace Period */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Late Grace Period" actions={isAdmin && (
          <Btn size="sm" onClick={() => save('grace', '/settings/late-grace', { minutes: graceForm })} disabled={saving.grace}>
            {saving.grace ? <Spinner /> : 'Save'}
          </Btn>
        )} />
        <div className="text-xs text-gray-500 mb-3.5">
          Staff arriving within this many minutes after shift start are NOT marked late. Set to 0 for zero tolerance.
        </div>
        <div className="max-w-[200px]">
          <FormRow label="MINUTES">
            <input type="number" className={inputCls} min="0" max="30" value={graceForm}
              disabled={!isAdmin} onChange={(e) => setGraceForm(Math.max(0, Math.min(30, parseInt(e.target.value) || 0)))} />
          </FormRow>
        </div>
      </Card>

      {/* Break Settings */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Break Settings" actions={isAdmin && <Btn size="sm" onClick={() => save('breaks', '/settings/breaks', breakForm)} disabled={saving.breaks}>{saving.breaks ? <Spinner /> : '💾 Save Breaks'}</Btn>} />
        <div className="text-xs text-gray-500 mb-3.5">Kuota harian per shift. Jika kuota habis, staff tidak bisa ambil break type tersebut lagi.</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(breakForm).map(([type, vals]) => (
            <div key={type} className="p-3.5 bg-gray-800 rounded-lg border border-gray-700">
              <div className="font-bold text-[13px] mb-3 text-emerald-400">{BREAK_TYPE_LABEL[type] || type}</div>
              <FormRow label="KUOTA HARIAN (menit)"><input type="number" className={inputCls} value={vals.daily_quota_minutes} disabled={!isAdmin} onChange={(e) => setBreakForm((f) => ({ ...f, [type]: { ...f[type], daily_quota_minutes: +e.target.value } }))} /></FormRow>
            </div>
          ))}
        </div>
      </Card>

      {/* Shift Times */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Shift Times" actions={isAdmin && <Btn size="sm" onClick={() => save('shifts', '/settings/shift-times', shiftForm)} disabled={saving.shifts}>{saving.shifts ? <Spinner /> : '💾 Save Shifts'}</Btn>} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {Object.entries(shiftForm).map(([shift, vals]) => (
            <div key={shift} className="p-3.5 bg-gray-800 rounded-lg border border-gray-700">
              <div className={`font-bold text-[13px] mb-3 ${shiftColorMap[shift]}`}>{shiftIcons[shift]}</div>
              <div className="grid grid-cols-2 gap-2.5">
                <FormRow label="START"><input type="time" className={inputCls} value={vals.start} disabled={!isAdmin} onChange={(e) => setShiftForm((f) => ({ ...f, [shift]: { ...f[shift], start: e.target.value } }))} /></FormRow>
                <FormRow label="END"><input type="time" className={inputCls} value={vals.end} disabled={!isAdmin} onChange={(e) => setShiftForm((f) => ({ ...f, [shift]: { ...f[shift], end: e.target.value } }))} /></FormRow>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* IP Whitelist */}
      <Card className="p-5 mb-4">
        <SectionHeader title="IP Whitelist" actions={isAdmin && <Btn size="sm" onClick={() => save('ip', '/settings/ip-whitelist', { prefixes: ipForm.prefixes.filter((p) => p.trim()) })} disabled={saving.ip}>{saving.ip ? <Spinner /> : '💾 Save IP'}</Btn>} />
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
          {ipForm.prefixes.map((p, i) => (
            <FormRow key={i} label={`IP SLOT ${i + 1}`} note={i === 0 ? 'contoh: 45.16.18.' : ''}>
              <input className={`${inputCls} font-mono`} value={p} disabled={!isAdmin} onChange={(e) => { const arr = [...ipForm.prefixes]; arr[i] = e.target.value; setIpForm({ prefixes: arr }); }} placeholder="xxx.xxx.xxx." />
            </FormRow>
          ))}
        </div>
      </Card>

      {/* Off Day Rules */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Off Day Rules" actions={isAdmin && <Btn size="sm" onClick={() => save('offday', '/settings/offday-rules', offDayForm)} disabled={saving.offday}>{saving.offday ? <Spinner /> : '💾 Save Rules'}</Btn>} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-[600px]">
          <FormRow label="OFF PER PERSON/MONTH"><input type="number" className={inputCls} value={offDayForm.per_person_per_month} disabled={!isAdmin} onChange={(e) => setOffDayForm((f) => ({ ...f, per_person_per_month: +e.target.value }))} /></FormRow>
          <FormRow label="MAX INDO OFF/SHIFT/DAY"><input type="number" className={inputCls} value={offDayForm.max_indo_off_per_shift_per_day} disabled={!isAdmin} onChange={(e) => setOffDayForm((f) => ({ ...f, max_indo_off_per_shift_per_day: +e.target.value }))} /></FormRow>
          <FormRow label="MAX LOCAL OFF/SHIFT/DAY"><input type="number" className={inputCls} value={offDayForm.max_local_off_per_shift_per_day} disabled={!isAdmin} onChange={(e) => setOffDayForm((f) => ({ ...f, max_local_off_per_shift_per_day: +e.target.value }))} /></FormRow>
        </div>
      </Card>

      {/* Telegram */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Telegram Admin Chat IDs" actions={isAdmin && <Btn size="sm" onClick={() => save('tg', '/settings/telegram', tgForm)} disabled={saving.tg}>{saving.tg ? <Spinner /> : '💾 Save'}</Btn>} />
        <div className="max-w-[480px]">
          <div className="flex gap-2 mb-2.5">
            <input placeholder="Enter chat ID" className={`${inputCls} flex-1 font-mono`} value={tgInput} disabled={!isAdmin} onChange={(e) => setTgInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && tgInput.trim()) { setTgForm((f) => ({ admin_chat_ids: [...f.admin_chat_ids, tgInput.trim()] })); setTgInput(''); } }} />
            {isAdmin && <Btn size="sm" onClick={() => { if (tgInput.trim()) { setTgForm((f) => ({ admin_chat_ids: [...f.admin_chat_ids, tgInput.trim()] })); setTgInput(''); } }}>+ Add</Btn>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {tgForm.admin_chat_ids.map((id, i) => (
              <div key={i} className="flex items-center gap-1.5 px-2.5 py-1 bg-gray-800 rounded-md border border-gray-700 font-mono text-xs">
                {id}
                {isAdmin && <button onClick={() => setTgForm((f) => ({ admin_chat_ids: f.admin_chat_ids.filter((_, j) => j !== i) }))} className="bg-transparent border-none text-red-400 cursor-pointer text-sm">&times;</button>}
              </div>
            ))}
            {tgForm.admin_chat_ids.length === 0 && <div className="text-gray-500 text-xs">No admin chat ID yet.</div>}
          </div>
        </div>
      </Card>

      {/* Notification Prefs */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Notification Preferences" actions={isAdmin && <Btn size="sm" onClick={() => save('notif', '/settings/notification-prefs', { muted_types: mutedNotifs })} disabled={saving.notif}>{saving.notif ? <Spinner /> : '💾 Save'}</Btn>} />
        <div className="text-xs text-gray-500 mb-3.5">Mute specific notification types.</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {NOTIF_TYPES.map((n) => (
            <label key={n.key} className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border cursor-pointer transition-colors ${isAdmin ? '' : 'opacity-50 cursor-default'} ${mutedNotifs.includes(n.key) ? 'bg-red-500/10 border-red-500/30' : 'bg-gray-800 border-gray-700'}`}>
              <input type="checkbox" checked={!mutedNotifs.includes(n.key)} disabled={!isAdmin} onChange={() => setMutedNotifs((prev) => prev.includes(n.key) ? prev.filter((t) => t !== n.key) : [...prev, n.key])} className="accent-emerald-500 w-4 h-4" />
              <div><div className="text-[13px] font-semibold">{n.label}</div><div className="text-[10px] text-gray-500">{n.desc}</div></div>
            </label>
          ))}
        </div>
      </Card>

      {/* Registration PIN */}
      <Card className="p-5 mb-4">
        <SectionHeader title="Registration PIN" actions={isAdmin && (
          <Btn size="sm" onClick={() => save('pin', '/settings/registration-pin', { pin: pinForm })} disabled={saving.pin}>
            {saving.pin ? <Spinner /> : 'Save PIN'}
          </Btn>
        )} />
        <div className="text-xs text-gray-500 mb-3.5">
          Staff must enter this PIN when using /register in Telegram. Change regularly for security.
        </div>
        <div className="max-w-[300px] flex gap-2">
          <input
            type={showPin ? 'text' : 'password'}
            className={inputCls}
            value={pinForm}
            disabled={!isAdmin}
            onChange={(e) => setPinForm(e.target.value)}
            placeholder="Min 4 characters"
          />
          <Btn variant="ghost" size="sm" onClick={() => setShowPin(!showPin)}>
            {showPin ? 'Hide' : 'Show'}
          </Btn>
        </div>
      </Card>

      {/* QR + Workstations */}
      <Card className="p-5 mb-4">
        <SectionHeader title="QR Scan — Back to Work" actions={isAdmin && (
          <Btn size="sm" onClick={async () => {
            const next = !qrRequired; setSaving((s) => ({ ...s, qr: true }));
            try { await apiFetch(token, '/settings/qr-required', { method: 'PUT', body: { enabled: next } }); setQrRequired(next); setToast({ type: 'ok', text: `QR scan ${next ? 'enabled' : 'disabled'}.` }); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setSaving((s) => ({ ...s, qr: false })); }
          }} disabled={saving.qr}>{saving.qr ? <Spinner /> : qrRequired ? '🔒 Disable QR' : '🔓 Enable QR'}</Btn>
        )} />
        <div className="text-xs text-gray-500 mb-3.5">Jika diaktifkan, staff harus scan QR dari monitor kantor (Live Board) saat kembali dari break. QR bersifat temporary per break (5 menit). Jika dimatikan, cukup klik tombol "Back to Work".</div>
        <div className="flex items-center gap-2.5 mb-5">
          <div className={`w-2.5 h-2.5 rounded-full ${qrRequired ? 'bg-emerald-400' : 'bg-gray-500'}`} />
          <span className={`font-semibold text-[13px] ${qrRequired ? 'text-emerald-400' : 'text-gray-500'}`}>{qrRequired ? 'QR Scan AKTIF' : 'QR Scan NONAKTIF (click only)'}</span>
        </div>

        <div className="border-t border-gray-800 pt-4">
          <div className="font-bold text-sm mb-3">Workstations</div>
          {isAdmin && (
            <div className="flex gap-2 mb-3.5">
              <input placeholder="Nama workstation" className={`${inputCls} flex-[2]`} value={wsForm.name} onChange={(e) => setWsForm((f) => ({ ...f, name: e.target.value }))} />
              <input placeholder="Dept (opsional)" className={`${inputCls} flex-1`} value={wsForm.department} onChange={(e) => setWsForm((f) => ({ ...f, department: e.target.value }))} />
              <Btn size="sm" disabled={!wsForm.name.trim() || saving.addWs} onClick={async () => {
                setSaving((s) => ({ ...s, addWs: true }));
                try { await apiFetch(token, '/settings/workstations', { method: 'POST', body: wsForm }); setWsForm({ name: '', department: '' }); setToast({ type: 'ok', text: 'Workstation created.' }); fetchSettings(); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setSaving((s) => ({ ...s, addWs: false })); }
              }}>{saving.addWs ? <Spinner /> : '+ Add'}</Btn>
            </div>
          )}
          {workstations.length === 0 && <div className="text-gray-500 text-xs py-3">Belum ada workstation. Tambahkan untuk generate QR code.</div>}
          <div className="grid gap-2">
            {workstations.map((ws) => (
              <div key={ws.id} className={`flex items-center justify-between px-3.5 py-2.5 bg-gray-800 rounded-lg border ${ws.is_active ? 'border-gray-700' : 'border-red-500/30'}`}>
                <div className="flex-1">
                  <div className="font-semibold text-[13px]">{ws.name} {!ws.is_active && <span className="text-red-400 text-[11px]">(inactive)</span>}</div>
                  <div className="text-[11px] text-gray-500">{ws.department || '—'}</div>
                  <div className="text-[10px] text-emerald-400 font-mono mt-0.5">QR: WMS-{ws.qr_token}</div>
                </div>
                {isAdmin && (
                  <div className="flex gap-1.5">
                    <Btn size="sm" variant="ghost" onClick={() => { const val = 'WMS-' + ws.qr_token; navigator.clipboard?.writeText(val); setToast({ type: 'ok', text: `QR value copied: ${val}` }); }}>📋</Btn>
                    <Btn size="sm" variant="ghost" onClick={async () => {
                      setSaving((s) => ({ ...s, ['ws' + ws.id]: true }));
                      try { await apiFetch(token, `/settings/workstations/${ws.id}/toggle`, { method: 'PUT' }); fetchSettings(); } catch (e) { setToast({ type: 'error', text: e.message }); } finally { setSaving((s) => ({ ...s, ['ws' + ws.id]: false })); }
                    }}>{ws.is_active ? '⏸' : '▶'}</Btn>
                    <Btn size="sm" variant="danger" onClick={async () => {
                      if (!window.confirm('Delete workstation ' + ws.name + '?')) return;
                      try { await apiFetch(token, `/settings/workstations/${ws.id}`, { method: 'DELETE' }); setToast({ type: 'ok', text: 'Deleted.' }); fetchSettings(); } catch (e) { setToast({ type: 'error', text: e.message }); }
                    }}>🗑</Btn>
                  </div>
                )}
              </div>
            ))}
          </div>
          {workstations.length > 0 && <div className="mt-3 text-[11px] text-gray-500">Gunakan nilai QR (WMS-xxxxx) untuk dicetak sebagai QR code. Staff scan QR ini dengan Telegram saat kembali dari break.</div>}
        </div>
      </Card>
    </div>
  );
}
