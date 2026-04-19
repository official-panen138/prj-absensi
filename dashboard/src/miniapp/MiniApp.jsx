import { useState, useEffect, useCallback } from 'react';

const API = '/api/bot';

async function api(path, token, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const STATUS_LABEL = {
  working: '💻 Working',
  smoking: '🚬 On Smoke Break',
  toilet: '🚻 On Toilet Break',
  outside: '🏪 Outside',
  offline: '⭘ Offline',
};

const START_QUOTES = [
  'Setiap panggilan adalah peluang baru. Let\'s close deals hari ini! 📞🔥',
  'Marketing bukan cuma jual produk — kita bangun hubungan. Semangat!',
  'Konsistensi mengalahkan intensitas. Target hari ini pasti tercapai! 📈',
  'Pelanggan senang adalah kemenangan. Buat mereka tersenyum hari ini! ⭐',
  'Kamu bukan sekadar marketing, kamu storyteller brand ini. 🎯',
  'Hari ini peluang terbaik untuk jadi versi terbaik dirimu. Go get it!',
  'Behind every sale, ada effort luar biasa. Appreciate your hustle! 💪',
  'No pressure no diamonds. Target menanti, tim ini percaya padamu!',
  'Lead terbaik datang pada yang paling konsisten. Itu kamu! 🚀',
  'Marketing hebat = empati + eksekusi. Tunjukkan dua-duanya hari ini!',
];

const END_QUOTES = [
  'Terima kasih atas kerja keras hari ini! Prestasi dibangun setiap hari. 🏆',
  'Well done! Rest well, tomorrow we conquer again. 💙',
  'Setiap usaha kamu hari ini bawa tim lebih dekat ke target. Makasih banyak!',
  'Shift selesai. Kamu bagian penting dari tim ini — appreciated! 🌟',
  'Kerja keras hari ini = modal sukses besok. Istirahat yang cukup ya!',
  'Hebat! Pulang dengan bangga, besok kita tebar pesona lagi. 🚀',
  'Terima kasih sudah memberi yang terbaik hari ini. Recharge dulu! ⚡',
  'Kamu rockstar! See you tomorrow dengan energi fresh. 😊',
  'Mission complete for today. Kamu bikin tim lebih kuat. Thanks!',
  'Good work today! Proud to have you di tim marketing ini. 🙌',
];

const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];

export default function MiniApp() {
  const [token, setToken] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [now, setNow] = useState(Date.now());
  const [popup, setPopup] = useState(null);
  const [showSwap, setShowSwap] = useState(false);
  const [swapForm, setSwapForm] = useState({ type: 'off', target_date: '', reason: '', target_staff_id: '', partner_date: '' });
  const [colleagues, setColleagues] = useState([]);
  const [partnerShift, setPartnerShift] = useState(null);

  useEffect(() => {
    if (showSwap && colleagues.length === 0 && token) {
      api('/colleagues', token).then((r) => setColleagues(r.data || [])).catch(() => {});
    }
  }, [showSwap, token, colleagues.length]);

  useEffect(() => {
    if (swapForm.type === 'trade' && swapForm.target_staff_id && (swapForm.partner_date || swapForm.target_date) && token) {
      const d = swapForm.partner_date || swapForm.target_date;
      api(`/colleagues/${swapForm.target_staff_id}/shift/${d}`, token).then((r) => setPartnerShift(r.data || null)).catch(() => setPartnerShift(null));
    } else { setPartnerShift(null); }
  }, [swapForm.type, swapForm.target_staff_id, swapForm.partner_date, swapForm.target_date, token]);

  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }
    const initData = tg?.initData || '';
    if (!initData) {
      // dev fallback: allow manual login via prompt during local testing
      setErr('Telegram WebApp tidak terdeteksi. Buka via tombol Open WMS di bot.');
      setLoading(false);
      return;
    }
    api('/auth/telegram', null, { method: 'POST', body: { initData } })
      .then((r) => { setToken(r.token); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const refresh = useCallback(async (t) => {
    try {
      const r = await api('/me', t || token);
      setMe(r);
    } catch (e) { setErr(e.message); }
  }, [token]);

  useEffect(() => { if (token) refresh(token); }, [token, refresh]);

  const act = async (path, body) => {
    setBusy(true); setErr(''); setInfo('');
    try {
      const r = await api(path, token, { method: 'POST', body });
      setInfo('✓ OK');
      if (path === '/clock-in') {
        const custom = me?.motivation_quotes?.start;
        const pool = (custom && custom.length) ? custom : START_QUOTES;
        setPopup({ kind: 'start', title: '🚀 Selamat Bekerja!', quote: pickRandom(pool), color: '#34d399' });
      } else if (path === '/clock-out') {
        const custom = me?.motivation_quotes?.end;
        const pool = (custom && custom.length) ? custom : END_QUOTES;
        setPopup({ kind: 'end', title: '🙏 Terima Kasih!', quote: pickRandom(pool), color: '#60a5fa' });
      }
      await refresh();
      return r;
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // 2-step: request QR (server push ke grup) → buka scanner
  const requestThenScan = async (requestPath, scanLabel, finalPath) => {
    const tg = window.Telegram?.WebApp;
    if (!tg?.showScanQrPopup) {
      setErr('QR scanner tidak didukung di versi Telegram ini. Update Telegram app.');
      return;
    }
    setErr(''); setInfo('');
    setBusy(true);
    try {
      await api(requestPath, token, { method: 'POST' });
      setInfo('✓ QR dikirim ke grup monitor. Buka kamera untuk scan.');
    } catch (e) {
      setErr(e.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    setTimeout(() => {
      tg.showScanQrPopup({ text: scanLabel }, (text) => {
        if (!text) return false;
        tg.closeScanQrPopup();
        const tokenOnly = String(text).replace(/^WMS-/, '');
        act(finalPath, { qr_token: tokenOnly });
        return true;
      });
    }, 800);
  };
  const scanAndClockIn = () => requestThenScan('/clock-in-request-qr', 'Scan QR START dari grup monitor', '/clock-in-qr');
  const scanAndClockOut = () => requestThenScan('/clock-out-request-qr', 'Scan QR PULANG dari grup monitor', '/clock-out-qr');

  const scanQrAndEnd = async () => {
    const tg = window.Telegram?.WebApp;
    if (!tg?.showScanQrPopup) {
      setErr('QR scanner tidak didukung di versi Telegram ini. Update Telegram app.');
      return;
    }
    setErr(''); setInfo('');
    setBusy(true);
    try {
      // Request QR baru → di-push ke monitor group
      await api('/break-request-qr', token, { method: 'POST' });
      setInfo('✓ QR dikirim ke grup monitor. Buka kamera untuk scan.');
    } catch (e) {
      setErr('Gagal request QR: ' + e.message);
      setBusy(false);
      return;
    }
    setBusy(false);
    // Tunggu sebentar lalu buka scanner
    setTimeout(() => {
      tg.showScanQrPopup({ text: 'Scan QR dari grup monitor' }, (text) => {
        const m = text && text.match(/qr_(\d+)_([a-f0-9]+)/);
        if (!m) {
          setErr('QR tidak dikenali. Pastikan scan QR dari grup monitor.');
          return false;
        }
        tg.closeScanQrPopup();
        act('/break-end-qr', { break_id: parseInt(m[1]), qr_token: m[2] });
        return true;
      });
    }, 800);
  };

  if (loading) return <div style={{padding:24,textAlign:'center'}}>Loading…</div>;
  if (err && !token) return <div style={{padding:24,textAlign:'center',color:'#f87171'}}>{err}</div>;

  const att = me?.attendance;
  const status = att?.current_status || (att?.clock_out ? 'offline' : 'offline');
  const onBreak = ['smoking', 'toilet', 'outside'].includes(status);
  const isWorking = status === 'working' && att?.clock_in && !att?.clock_out;
  const notStarted = !att?.clock_in;
  const ended = att?.clock_out;

  const Btn = ({ onClick, disabled, color = 'emerald', children }) => (
    <button onClick={onClick} disabled={disabled || busy}
      style={{
        width:'100%',padding:'18px 20px',borderRadius:14,border:'none',cursor:'pointer',
        background: color === 'red' ? '#dc2626' : color === 'amber' ? '#d97706' : color === 'gray' ? '#374151' : '#10b981',
        color:'#fff',fontWeight:700,fontSize:16,marginBottom:10,
        opacity: (disabled || busy) ? 0.5 : 1, transition:'all .15s',
      }}>{children}</button>
  );

  return (
    <div style={{maxWidth:420,margin:'0 auto',padding:'20px 18px',fontFamily:'system-ui,-apple-system,sans-serif',color:'#f3f4f6',minHeight:'100vh',background:'rgb(17 24 39)'}}>
      {popup && (
        <div
          onClick={() => setPopup(null)}
          style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.85)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:9999,padding:20,animation:'fadeIn .2s'}}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth:360,background:'rgb(31 41 55)',borderRadius:20,padding:'28px 24px',
              border:`2px solid ${popup.color}33`,boxShadow:`0 0 40px ${popup.color}22`,
              textAlign:'center'
            }}
          >
            <div style={{fontSize:32,marginBottom:12}}>{popup.title.split(' ')[0]}</div>
            <div style={{fontSize:18,fontWeight:800,color:popup.color,marginBottom:16}}>
              {popup.title.split(' ').slice(1).join(' ')}
            </div>
            <div style={{fontSize:14,lineHeight:1.55,color:'#e5e7eb',marginBottom:22}}>
              {popup.quote}
            </div>
            <div style={{fontSize:11,color:'#9ca3af',marginBottom:16,fontFamily:'monospace'}}>
              — PNNGROUP Marketing Team —
            </div>
            <button
              onClick={() => setPopup(null)}
              style={{
                width:'100%',padding:'14px',borderRadius:12,border:'none',
                background:popup.color,color:'#0b1220',fontWeight:700,fontSize:15,cursor:'pointer'
              }}
            >
              {popup.kind === 'start' ? "Let's Go! 🔥" : 'Terima kasih 🙏'}
            </button>
          </div>
        </div>
      )}

      <div style={{textAlign:'center',marginBottom:18}}>
        <div style={{fontFamily:'monospace',fontWeight:700,fontSize:14,color:'#34d399',letterSpacing:2}}>PNNGROUP</div>
        <div style={{fontSize:11,color:'#6b7280',marginTop:2}}>Workforce Mini App</div>
      </div>

      <div style={{background:'rgb(31 41 55)',borderRadius:14,padding:16,marginBottom:18,border:'1px solid rgb(55 65 81)'}}>
        <div style={{fontWeight:700,fontSize:15}}>{me?.staff?.name}</div>
        <div style={{fontSize:12,color:'#9ca3af',marginBottom:8}}>
          {me?.staff?.department} · {me?.staff?.today_shift || me?.staff?.current_shift}
          {me?.staff?.today_shift && me?.staff?.today_shift !== me?.staff?.current_shift && (
            <span style={{marginLeft:6,fontSize:10,color:'#fbbf24'}}>(rotasi)</span>
          )}
        </div>
        <div style={{fontSize:13,fontWeight:600,color: onBreak ? '#fbbf24' : isWorking ? '#34d399' : '#6b7280'}}>
          {STATUS_LABEL[status] || '⭘ Not Started'}
        </div>
        {att?.clock_in && (
          <div style={{fontSize:11,color:'#6b7280',marginTop:4,fontFamily:'monospace'}}>
            ▶ {new Date(att.clock_in).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}
            {att.late_minutes > 0 && <span style={{color:'#fb7185'}}> +{att.late_minutes}m late</span>}
            {att.clock_out && <> · ⏹ {new Date(att.clock_out).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}</>}
          </div>
        )}
      </div>

      {info && <div style={{padding:'10px 12px',background:'rgba(16,185,129,0.15)',color:'#34d399',borderRadius:10,fontSize:13,marginBottom:10}}>{info}</div>}
      {err && <div style={{padding:'10px 12px',background:'rgba(239,68,68,0.15)',color:'#f87171',borderRadius:10,fontSize:13,marginBottom:10}}>⚠ {err}</div>}

      {me && me.ip_allowed === false && (
        <div style={{padding:'14px 14px',background:'rgba(239,68,68,0.15)',border:'1px solid rgba(239,68,68,0.4)',borderRadius:12,fontSize:13,marginBottom:14,lineHeight:1.5}}>
          <div style={{fontWeight:700,color:'#fca5a5',marginBottom:4}}>📍 Anda di luar jaringan kantor</div>
          <div style={{fontSize:12,color:'#fca5a5'}}>
            Kembali ke kantor dan gunakan IP kantor untuk Clock-In atau Back to Work.
          </div>
          {me.client_ip && <div style={{fontSize:10,color:'#9ca3af',marginTop:6,fontFamily:'monospace'}}>IP saat ini: {me.client_ip}</div>}
        </div>
      )}

      {notStarted && (
        <Btn onClick={scanAndClockIn} disabled={me?.ip_allowed === false}>
          📷 Scan QR — START (Clock In){me?.ip_allowed === false ? ' · Butuh IP Kantor' : ''}
        </Btn>
      )}

      {isWorking && (() => {
        const q = me?.break_quotas || {};
        const ipBlocked = me?.ip_allowed === false;
        const mkBtn = (type, label) => {
          const quota = q[type];
          const exhausted = quota && quota.remaining <= 0;
          const disabled = exhausted || ipBlocked;
          const suffix = quota ? ` · ${quota.used}m/${quota.limit}m` : '';
          const badge = ipBlocked ? ' · Butuh IP Kantor' : exhausted ? ' · HABIS' : '';
          return (
            <Btn color="amber" onClick={() => act('/break-start', { type })} disabled={disabled}>
              {label}{suffix}{badge}
            </Btn>
          );
        };
        return (
          <>
            <div style={{fontSize:11,color:'#6b7280',marginBottom:6,marginTop:8}}>BREAK</div>
            {mkBtn('smoke', '🚬 Smoke Break')}
            {mkBtn('toilet', '🚻 Toilet')}
            {mkBtn('outside', '🏪 Go Out')}
            <div style={{fontSize:11,color:'#6b7280',marginBottom:6,marginTop:14}}>END</div>
            <Btn color="red" onClick={scanAndClockOut} disabled={me?.ip_allowed === false}>
              📷 Scan QR — END (Clock Out){me?.ip_allowed === false ? ' · Butuh IP Kantor' : ''}
            </Btn>
          </>
        );
      })()}

      {onBreak && (() => {
        const elapsedSec = att.break_start ? Math.max(0, Math.floor((now - new Date(att.break_start).getTime()) / 1000)) : 0;
        const limitSec = (att.break_limit || 0) * 60;
        const remainingSec = limitSec - elapsedSec;
        const overtime = remainingSec < 0;
        const pct = limitSec ? Math.min(100, (elapsedSec / limitSec) * 100) : 0;
        const fmt = (s) => `${Math.floor(Math.abs(s) / 60)}m ${String(Math.abs(s) % 60).padStart(2, '0')}s`;
        const barColor = overtime ? '#ef4444' : pct > 80 ? '#fbbf24' : '#34d399';
        const textColor = overtime ? '#fca5a5' : pct > 80 ? '#fbbf24' : '#34d399';
        const sign = remainingSec < 0 ? '-' : '';
        return (
          <>
            <div style={{padding:'14px 12px',background:'rgb(31 41 55)',border:`1px solid ${overtime ? 'rgba(239,68,68,0.5)' : 'rgb(55 65 81)'}`,borderRadius:12,marginBottom:14}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:8}}>
                <span style={{fontSize:11,color:'#9ca3af',letterSpacing:1}}>{overtime ? 'OVERTIME' : 'SISA WAKTU'}</span>
                <span style={{fontFamily:'monospace',fontWeight:700,fontSize:22,color:textColor}}>
                  {sign}{fmt(remainingSec)}
                </span>
              </div>
              <div style={{height:6,background:'rgb(55 65 81)',borderRadius:3,overflow:'hidden'}}>
                <div style={{height:'100%',width:`${pct}%`,background:barColor,transition:'width .5s'}} />
              </div>
              <div style={{display:'flex',justifyContent:'space-between',marginTop:6,fontSize:10,color:'#6b7280',fontFamily:'monospace'}}>
                <span>{fmt(elapsedSec)} terpakai</span>
                <span>kuota: {att.break_limit}m</span>
              </div>
              {overtime && <div style={{marginTop:8,padding:'6px 10px',background:'rgba(239,68,68,0.15)',color:'#fca5a5',borderRadius:6,fontSize:11,textAlign:'center'}}>⚠ Anda melewati batas waktu break</div>}
            </div>

            {me?.ip_allowed === false ? (
              <div style={{padding:'12px',background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:10,fontSize:12,color:'#fca5a5',marginBottom:14,textAlign:'center'}}>
                ⚠ Back to Work tidak bisa dari luar kantor.<br />
                Kembali ke jaringan kantor untuk scan QR.
              </div>
            ) : (
              <div style={{padding:'12px',background:'rgba(251,191,36,0.1)',border:'1px solid rgba(251,191,36,0.3)',borderRadius:10,fontSize:12,color:'#fbbf24',marginBottom:14,textAlign:'center'}}>
                ⏱ Break aktif. Klik tombol di bawah → kamera akan terbuka untuk scan QR di grup monitor.
              </div>
            )}
            <Btn color="emerald" onClick={scanQrAndEnd} disabled={me?.ip_allowed === false}>
              📷 Scan QR — Back to Work{me?.ip_allowed === false ? ' · Butuh IP Kantor' : ''}
            </Btn>
          </>
        );
      })()}

      {ended && (
        <div style={{padding:16,textAlign:'center',color:'#6b7280',fontSize:13}}>
          Shift selesai. Sampai jumpa besok!
          {att.productive_ratio != null && (
            <div style={{marginTop:6,color:'#34d399',fontWeight:700}}>Productivity: {att.productive_ratio}%</div>
          )}
        </div>
      )}

      {/* Request Swap Section */}
      <div style={{marginTop:18,paddingTop:14,borderTop:'1px solid rgb(31 41 55)'}}>
        <button
          onClick={() => setShowSwap(!showSwap)}
          style={{width:'100%',padding:'10px',background:'transparent',border:'1px solid rgb(55 65 81)',borderRadius:10,color:'#9ca3af',fontSize:13,cursor:'pointer'}}
        >
          🔄 {showSwap ? 'Tutup' : 'Request Swap / Off'}
        </button>
        {showSwap && (
          <div style={{marginTop:12,padding:14,background:'rgb(31 41 55)',borderRadius:12,border:'1px solid rgb(55 65 81)'}}>
            <div style={{display:'flex',gap:8,marginBottom:12}}>
              <button onClick={() => setSwapForm((f) => ({ ...f, type: 'off' }))}
                style={{flex:1,padding:'8px',borderRadius:8,border:'none',cursor:'pointer',
                  background: swapForm.type === 'off' ? '#dc2626' : '#374151',
                  color:'#fff',fontSize:12,fontWeight:600}}>📅 Request OFF</button>
              <button onClick={() => setSwapForm((f) => ({ ...f, type: 'trade' }))}
                style={{flex:1,padding:'8px',borderRadius:8,border:'none',cursor:'pointer',
                  background: swapForm.type === 'trade' ? '#2563eb' : '#374151',
                  color:'#fff',fontSize:12,fontWeight:600}}>🔄 Trade Shift</button>
            </div>

            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:'#9ca3af',marginBottom:4,letterSpacing:1}}>TANGGAL ANDA</div>
              <input type="date" value={swapForm.target_date} onChange={(e) => setSwapForm((f) => ({ ...f, target_date: e.target.value }))}
                style={{width:'100%',padding:'10px',borderRadius:8,border:'1px solid rgb(55 65 81)',background:'rgb(17 24 39)',color:'#f3f4f6',fontSize:13}} />
            </div>

            {swapForm.type === 'trade' && (
              <>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:'#9ca3af',marginBottom:4,letterSpacing:1}}>PARTNER (rekan dept)</div>
                  <select value={swapForm.target_staff_id} onChange={(e) => setSwapForm((f) => ({ ...f, target_staff_id: e.target.value }))}
                    style={{width:'100%',padding:'10px',borderRadius:8,border:'1px solid rgb(55 65 81)',background:'rgb(17 24 39)',color:'#f3f4f6',fontSize:13}}>
                    <option value="">— Pilih partner —</option>
                    {colleagues.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {colleagues.length === 0 && <div style={{fontSize:11,color:'#9ca3af',marginTop:4}}>Tidak ada rekan di department Anda.</div>}
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:'#9ca3af',marginBottom:4,letterSpacing:1}}>TANGGAL PARTNER (kosong = sama dengan tanggal Anda)</div>
                  <input type="date" value={swapForm.partner_date} onChange={(e) => setSwapForm((f) => ({ ...f, partner_date: e.target.value }))}
                    style={{width:'100%',padding:'10px',borderRadius:8,border:'1px solid rgb(55 65 81)',background:'rgb(17 24 39)',color:'#f3f4f6',fontSize:13}} />
                  {partnerShift && (
                    <div style={{fontSize:11,marginTop:4,color: partnerShift.status === 'work' ? '#34d399' : '#fb7185'}}>
                      Jadwal partner: {partnerShift.status === 'work' ? `${partnerShift.shift} (work)` : partnerShift.status?.toUpperCase()}
                    </div>
                  )}
                </div>
              </>
            )}

            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:'#9ca3af',marginBottom:4,letterSpacing:1}}>ALASAN (opsional)</div>
              <textarea value={swapForm.reason} onChange={(e) => setSwapForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="Acara keluarga / sakit / dll"
                style={{width:'100%',padding:'10px',borderRadius:8,border:'1px solid rgb(55 65 81)',background:'rgb(17 24 39)',color:'#f3f4f6',fontSize:13,minHeight:60,resize:'vertical'}} />
            </div>

            <Btn color={swapForm.type === 'off' ? 'red' : 'emerald'} onClick={async () => {
              if (!swapForm.target_date) { setErr('Pilih tanggal Anda'); return; }
              if (swapForm.type === 'trade' && !swapForm.target_staff_id) { setErr('Pilih partner'); return; }
              const body = {
                target_date: swapForm.target_date,
                reason: swapForm.reason,
                target_staff_id: swapForm.type === 'trade' ? +swapForm.target_staff_id : null,
                partner_date: swapForm.type === 'trade' ? (swapForm.partner_date || null) : null,
              };
              try {
                setBusy(true);
                await api('/swap-request', token, { method: 'POST', body });
                setInfo('✓ Request dikirim ke admin. Tunggu approval di Telegram.');
                setSwapForm({ type: 'off', target_date: '', reason: '', target_staff_id: '', partner_date: '' });
                setShowSwap(false);
              } catch (e) { setErr(e.message); }
              finally { setBusy(false); }
            }} disabled={busy}>
              📤 Submit {swapForm.type === 'off' ? 'Request OFF' : 'Trade Request'}
            </Btn>
          </div>
        )}
      </div>

      <div style={{textAlign:'center',marginTop:24,fontSize:10,color:'#4b5563',fontFamily:'monospace'}}>
        SECURE_ACCESS // STAFF_PANEL
      </div>
    </div>
  );
}
