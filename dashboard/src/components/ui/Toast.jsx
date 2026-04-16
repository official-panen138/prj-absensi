import { useEffect } from 'react';

export default function Toast({ msg, onClose }) {
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [msg, onClose]);

  if (!msg) return null;
  const isErr = msg.type === 'error';

  return (
    <div className={`fixed bottom-6 right-6 z-[9000] px-5 py-3 rounded-lg font-semibold text-white text-[13px] max-w-[380px] animate-fade-in backdrop-blur-xl shadow-lg ${isErr ? 'bg-red-500/90 border border-red-400' : 'bg-emerald-500/90 border border-emerald-400'}`}>
      {msg.text}
      <button onClick={onClose} className="ml-3 text-white text-base bg-transparent border-none cursor-pointer">&times;</button>
    </div>
  );
}
