import { useRef, useSyncExternalStore } from "react";
import { ACCENTS, nextAccent, readAppliedAccent, subscribeAccent, type Accent } from "../accent.js";
const labels: Record<Accent, string> = { current: "Gold (default)", blue: "Blue", gold: "Gold", indigo: "Indigo", teal: "Teal", ember: "Ember" };
export function AccentPicker({ onChange }: { onChange: (accent: Accent) => void }): React.JSX.Element {
  const value = useSyncExternalStore(subscribeAccent, readAppliedAccent);
  const buttons = useRef<Partial<Record<Accent, HTMLButtonElement>>>({});
  return <div className="accent-picker" role="radiogroup" aria-label="Accent color">
    {ACCENTS.map(accent => <button key={accent} type="button" role="radio"
      className="accent-swatch" data-accent={accent} aria-label={labels[accent]}
      title={labels[accent]} aria-checked={value === accent} tabIndex={value === accent ? 0 : -1}
      ref={node => { if (node) buttons.current[accent] = node; else delete buttons.current[accent]; }}
      onClick={() => onChange(accent)} onKeyDown={event => {
        const next = nextAccent(accent, event.key);
        if (next === null) return;
        event.preventDefault();
        onChange(next);
        buttons.current[next]?.focus();
      }}>{value === accent && <span aria-hidden="true">✓</span>}</button>)}
  </div>;
}
