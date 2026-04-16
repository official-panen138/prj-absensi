// Utility functions ported from old dashboard
export function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Phnom_Penh' });
}

export function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtElapsed(min) {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}j ${min % 60}m`;
}

export function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(+y, +m - 1, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
}

export function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentYM() {
  const d = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Phnom_Penh' });
  return d.substring(0, 7);
}

export function todayISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Phnom_Penh' });
}

export const STATUS_LABEL = { working: '💻 Working', smoking: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out', offline: '⭘ Offline' };
export const BREAK_TYPE_LABEL = { smoke: '🚬 Smoke', toilet: '🚻 Toilet', outside: '🏪 Go Out' };
export const SCHED_LABEL = { work: { label: 'Work', emoji: '🟢' }, off: { label: 'Off', emoji: '🔴' }, sick: { label: 'Sick', emoji: '🤒' }, leave: { label: 'Leave', emoji: '✈️' } };

export function statusColor(s) {
  return { working: 'text-emerald-400', smoking: 'text-amber-400', toilet: 'text-blue-400', outside: 'text-purple-400', offline: 'text-gray-500' }[s] || 'text-gray-500';
}

export function statusColorHex(s) {
  return { working: '#34d399', smoking: '#fb923c', toilet: '#38bdf8', outside: '#a78bfa', offline: '#6b7280' }[s] || '#6b7280';
}

export function shiftColorClass(s) {
  return { morning: 'text-emerald-400', middle: 'text-yellow-400', night: 'text-purple-400' }[s] || 'text-emerald-400';
}

export function shiftBgClass(s) {
  return { morning: 'bg-emerald-400/20 text-emerald-400 border-emerald-400/30', middle: 'bg-yellow-400/20 text-yellow-400 border-yellow-400/30', night: 'bg-purple-400/20 text-purple-400 border-purple-400/30' }[s] || 'bg-emerald-400/20 text-emerald-400 border-emerald-400/30';
}

export function schedBgClass(s) {
  return { work: '', off: 'bg-red-400/25', sick: 'bg-yellow-400/25', leave: 'bg-blue-400/25' }[s] || '';
}

export const NAV_ITEMS = [
  { id: 'live', icon: '📊', label: 'Live Board' },
  { id: 'schedule', icon: '📅', label: 'Schedule' },
  { id: 'staff', icon: '👥', label: 'Staff' },
  { id: 'swap', icon: '🔄', label: 'Swap Requests' },
  { id: 'reports', icon: '📈', label: 'Reports' },
  { id: 'activity', icon: '📋', label: 'Activity Log' },
  { id: 'settings', icon: '⚙️', label: 'Settings' },
];

export const DEPARTMENTS = ['Customer Service', 'Finance', 'Captain', 'SEO Marketing', 'Social Media Marketing', 'CRM', 'Telemarketing'];
