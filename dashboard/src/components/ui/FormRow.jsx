export default function FormRow({ label, children, note }) {
  return (
    <div className="mb-3.5">
      <label className="block text-xs text-gray-400 mb-1.5 font-semibold">{label}</label>
      {children}
      {note && <div className="text-[11px] text-gray-500 mt-1">{note}</div>}
    </div>
  );
}
