export default function SectionHeader({ title, actions }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <div className="w-[3px] h-[18px] bg-emerald-500 rounded-sm" />
        <span className="font-bold text-base">{title}</span>
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}
