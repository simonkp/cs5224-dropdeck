import { cn } from '../../lib/utils';

/** A row of mutually exclusive options (radio semantics), like iOS's segmented control. */
export function Segmented<T extends string>(props: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; activeClass?: string }>;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={props.label} className={cn('grid gap-1 rounded-[14px] bg-sunken p-1', props.className)} style={{ gridTemplateColumns: `repeat(${props.options.length}, minmax(0, 1fr))` }}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={props.disabled}
            onClick={() => props.onChange(o.value)}
            className={cn(
              'h-10 cursor-pointer rounded-[10px] px-2 text-[13px] font-bold text-muted transition disabled:cursor-not-allowed disabled:opacity-60',
              on && (o.activeClass ?? 'bg-surface text-ink shadow-[0_1px_3px_rgba(16,17,20,0.12)]'),
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
