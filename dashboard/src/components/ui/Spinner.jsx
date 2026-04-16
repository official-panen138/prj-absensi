export default function Spinner({ className = '' }) {
  return (
    <div className={`inline-block w-5 h-5 border-2 border-gray-700 border-t-emerald-400 rounded-full animate-spin ${className}`} />
  );
}
