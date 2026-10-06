import { Minus, Plus } from 'lucide-react';

/** − n + with 44px targets. */
export function Stepper(props: { value: number; min: number; max: number; onChange: (n: number) => void; label: string; format?: (n: number) => string; step?: number }) {
  const step = props.step ?? 1;
  const btn = 'flex size-11 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface text-ink disabled:cursor-not-allowed disabled:opacity-40';
  return (
    <div className="flex items-center gap-1" role="group" aria-label={props.label}>
      <button type="button" className={btn} aria-label={`Less ${props.label.toLowerCase()}`} disabled={props.value <= props.min} onClick={() => props.onChange(Math.max(props.min, props.value - step))}>
        <Minus className="size-4" strokeWidth={2.4} />
      </button>
      <span className="tabular w-14 text-center text-base font-extrabold" aria-live="polite">{props.format ? props.format(props.value) : props.value}</span>
      <button type="button" className={btn} aria-label={`More ${props.label.toLowerCase()}`} disabled={props.value >= props.max} onClick={() => props.onChange(Math.min(props.max, props.value + step))}>
        <Plus className="size-4" strokeWidth={2.4} />
      </button>
    </div>
  );
}
