const COLOR_MAP = {
  emerald: 'bg-emerald-400/15 text-emerald-400 border-emerald-400/30',
  red: 'bg-red-400/15 text-red-400 border-red-400/30',
  yellow: 'bg-yellow-400/15 text-yellow-400 border-yellow-400/30',
  blue: 'bg-blue-400/15 text-blue-400 border-blue-400/30',
  purple: 'bg-purple-400/15 text-purple-400 border-purple-400/30',
  green: 'bg-emerald-400/15 text-emerald-400 border-emerald-400/30',
  orange: 'bg-amber-400/15 text-amber-400 border-amber-400/30',
  gray: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
};

export default function Badge({ children, color = 'emerald', className = '' }) {
  const cls = COLOR_MAP[color] || COLOR_MAP.emerald;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap ${cls} ${className}`}>
      {children}
    </span>
  );
}
