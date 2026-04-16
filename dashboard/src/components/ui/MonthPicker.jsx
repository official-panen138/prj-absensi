import { monthLabel, prevMonth, nextMonth } from '../../lib/theme';
import Btn from './Btn';

export default function MonthPicker({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <Btn variant="ghost" size="sm" onClick={() => onChange(prevMonth(value))}>◀</Btn>
      <span className="font-mono font-bold text-emerald-400 min-w-[130px] text-center">{monthLabel(value)}</span>
      <Btn variant="ghost" size="sm" onClick={() => onChange(nextMonth(value))}>▶</Btn>
    </div>
  );
}
