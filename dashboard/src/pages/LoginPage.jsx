import { useState } from 'react';
import { apiFetch } from '../lib/api';
import { Card, Spinner, Btn, FormRow } from '../components/ui';

export default function LoginPage({ onLogin }) {
  const [form, setForm] = useState({ username: '', password: '' });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!form.username || !form.password) return setErr('Fill all fields.');
    setLoading(true);
    setErr('');
    try {
      const data = await apiFetch(null, '/auth/login', { method: 'POST', body: form });
      onLogin(data);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-950 bg-[radial-gradient(ellipse_at_20%_50%,rgba(16,185,129,0.12)_0%,transparent_60%),radial-gradient(ellipse_at_80%_20%,rgba(56,189,248,0.06)_0%,transparent_60%)]">
      <div className="w-full max-w-[380px] px-4 animate-fade-in">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-[60px] h-[60px] rounded-[14px] border-2 border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 to-transparent mb-4 text-[26px]">⚡</div>
          <div className="font-mono font-bold text-lg text-emerald-400 tracking-[2px]">S123GROUP</div>
          <div className="text-gray-500 text-xs mt-1">Workforce Management</div>
        </div>

        <Card className="p-7" glow>
          <div className="mb-1 text-xs text-gray-500 font-mono">&gt; AUTHENTICATE</div>
          <div className="h-px bg-gray-800 mb-5" />

          <FormRow label="USERNAME">
            <input
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors"
              value={form.username}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="admin"
              autoFocus
            />
          </FormRow>

          <FormRow label="PASSWORD">
            <input
              type="password"
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 outline-none focus:border-emerald-500 transition-colors"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="••••••••"
            />
          </FormRow>

          {err && (
            <div className="px-3 py-2 bg-red-500/15 border border-red-500/30 rounded-md text-red-400 text-xs mb-3">⚠ {err}</div>
          )}

          <Btn onClick={submit} disabled={loading} className="w-full justify-center mt-1">
            {loading ? <Spinner /> : 'LOGIN →'}
          </Btn>
        </Card>

        <div className="text-center mt-5 text-gray-500 text-[11px] font-mono">SECURE_ACCESS // ADMIN_ONLY</div>
      </div>
    </div>
  );
}
