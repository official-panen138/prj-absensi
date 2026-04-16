import { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../lib/api';
import { BREAK_TYPE_LABEL } from '../lib/theme';
import { Card } from '../components/ui';

export default function QRMonitorSection({ token }) {
  const [qrBreaks, setQrBreaks] = useState([]);
  const qrRefs = useRef({});

  const fetchQR = useCallback(async () => {
    try {
      const res = await apiFetch(token, '/activity/active-breaks-qr');
      setQrBreaks(res.data || []);
    } catch (e) {}
  }, [token]);

  useEffect(() => {
    fetchQR();
    const iv = setInterval(fetchQR, 10000);
    return () => clearInterval(iv);
  }, [fetchQR]);

  useEffect(() => {
    if (typeof window.QRCode === 'undefined') return;
    qrBreaks.forEach((b) => {
      const elId = 'qr-' + b.id;
      const el = document.getElementById(elId);
      if (!el) return;
      if (qrRefs.current[b.id] === b.qr_token) return;
      el.innerHTML = '';
      new window.QRCode(el, { text: 'WMSQR-' + b.qr_token, width: 180, height: 180, colorDark: '#000000', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M });
      qrRefs.current[b.id] = b.qr_token;
    });
  }, [qrBreaks]);

  if (qrBreaks.length === 0) return null;

  return (
    <Card className="px-5 py-4 mb-4 border-emerald-400/30">
      <div className="text-xs font-bold text-emerald-400 mb-3">📱 QR MONITOR — BACK TO WORK ({qrBreaks.length})</div>
      <div className="text-[11px] text-gray-500 mb-3">Staff harus scan QR ini dari Telegram untuk kembali bekerja.</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
        {qrBreaks.map((b) => {
          const elapsed = Math.round((Date.now() - new Date(b.start_time).getTime()) / 60000);
          const expiresSec = Math.max(0, Math.round((new Date(b.qr_expires_at).getTime() - Date.now()) / 1000));
          const expiredQR = expiresSec <= 0;
          const breakLabel = BREAK_TYPE_LABEL[b.type] || b.type;
          return (
            <div key={b.id} className={`p-3.5 bg-gray-800 rounded-xl border text-center ${expiredQR ? 'border-red-500/40' : 'border-gray-700'}`}>
              <div className="font-bold text-sm mb-0.5">{b.staff_name}</div>
              <div className="text-[11px] text-gray-500 mb-2">{b.department || '—'} · {breakLabel} · {elapsed}m</div>
              <div id={'qr-' + b.id} className="inline-block p-2 bg-white rounded-lg mb-2" />
              <div className={`text-[11px] font-mono font-semibold ${expiredQR ? 'text-red-400' : 'text-emerald-400'}`}>
                {expiredQR ? '⏰ QR Expired — klik Back to Work lagi' : `⏱ Expires: ${Math.floor(expiresSec / 60)}m ${String(expiresSec % 60).padStart(2, '0')}s`}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
