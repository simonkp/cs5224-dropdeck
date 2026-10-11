'use client';
import { useEffect, useRef, useState } from 'react';

/** Guards console routing, ordinary links and tab close. Save clears the guard synchronously. */
export function useUnsaved(value: string) {
  const initial = useRef(value);
  const [, render] = useState(0);
  const dirty = value !== initial.current;
  const active = useRef(dirty); active.current = dirty;
  useEffect(() => {
    if (!dirty) return;
    const confirm = (e: Event) => {
      if (!active.current) return;
      if (!window.confirm('Discard your unsaved changes?')) { e.preventDefault(); e.stopPropagation(); }
      else active.current = false;
    };
    const unload = (e: BeforeUnloadEvent) => { if (active.current) { e.preventDefault(); e.returnValue = ''; } };
    const click = (e: MouseEvent) => {
      const a = (e.target as Element).closest('a');
      if (a?.href && !a.hasAttribute('data-console-nav') && a.target !== '_blank' && !e.ctrlKey && !e.metaKey) confirm(e);
    };
    window.addEventListener('dd:navigate', confirm);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('dd:navigate', confirm); window.removeEventListener('beforeunload', unload); document.removeEventListener('click', click, true); };
  }, [dirty]);
  return { dirty, markSaved: () => { initial.current = value; active.current = false; render(n => n+1); } };
}
