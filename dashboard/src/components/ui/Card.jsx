export default function Card({ children, className = '', glow = false }) {
  return (
    <div className={`bg-gray-900 border rounded-xl transition-colors duration-300 ${glow ? 'border-emerald-700 shadow-[0_0_20px_rgba(16,185,129,0.12)]' : 'border-gray-800'} ${className}`}>
      {children}
    </div>
  );
}
