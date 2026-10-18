'use client';

import { useEffect, useRef, useState } from 'react';
import { Mail } from 'lucide-react';
import type { Drop, MerchantProfile } from '@dropdeck/shared';
import { paymentReminderTemplate, type ReminderOrder, type ReminderResult } from '@dropdeck/shared/payment-reminders';
import { api } from '../../lib/api';
import { message, price } from '../../lib/format';
import { Button } from '../../components/ui/button';

export function PaymentReminderPanel({ orders, profile, drop, mode, onSent, onClose }: {
  orders: ReminderOrder[]; profile: MerchantProfile; drop: Drop; mode: 'ses' | 'demo'; onSent: () => void; onClose: () => void;
}) {
  const [preview, setPreview] = useState(orders[0]!.ref);
  const [requestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ReminderResult[]>();
  const [error, setError] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  const order = orders.find(o => o.ref === preview) ?? orders[0]!;
  const template = paymentReminderTemplate(profile, drop, order);
  return <section ref={panel} tabIndex={-1} aria-label="Review payment reminders" className="mt-5 scroll-mt-4 rounded-2xl border border-line bg-sunken p-4 outline-none sm:p-5">
    <div className="flex items-start justify-between gap-3"><div><h3 className="flex items-center gap-2 font-bold"><Mail aria-hidden="true" className="size-4"/>Review payment reminders</h3><p className="mt-1 text-xs leading-relaxed text-muted">Each buyer receives a separate email with their own order details. Review the recipients and template before sending.</p></div><Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>Close</Button></div>
    <ul aria-label="Reminder recipients" className="my-4 divide-y divide-line rounded-xl bg-surface px-3">{orders.map(o => <li key={o.ref} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs"><span className="min-w-0 break-words"><strong>{o.name}</strong> · {o.email}<span className="mt-1 block text-muted">{o.ref} · {o.qty} × {o.variantName}</span></span><strong className="tabular-nums">{price(o.amountCents)}</strong></li>)}</ul>
    <label className="flex flex-col gap-1.5 text-xs font-bold text-muted">Preview email for<select className="h-10 rounded-xl border border-field bg-surface px-3 text-sm text-ink" value={preview} onChange={e => setPreview(e.target.value)}>{orders.map(o => <option key={o.ref} value={o.ref}>{o.ref} · {o.name}</option>)}</select></label>
    <div className="mt-3 rounded-xl border border-line bg-surface p-4"><p className="border-b border-line pb-3 text-sm font-bold">{template.subject}</p><p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap break-words">{template.text}</p></div>
    <p className="mt-3 text-xs leading-relaxed text-muted">Only awaiting-payment orders are eligible. The server checks current records again before sending. Accepted reminders are limited to one per order every 24 hours; up to 100 attempts per shop per UTC day. SES acceptance does not confirm inbox delivery.</p>
    {mode === 'demo' && <p className="mt-3 rounded-xl bg-warn-tint p-3 text-sm text-warn">Local demo: no email will be sent.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-danger">{error} You can retry this same request safely; already attempted orders will not be sent again.</p>}
    {results ? <div role="status" className="mt-4"><h4 className="font-bold">{mode === 'demo' ? 'Simulation results' : 'Sending results'}</h4><ul className="mt-2 space-y-2 text-xs leading-relaxed">{results.map(r => <li key={r.ref}><strong>{r.ref} · {r.status === 'accepted' ? mode === 'demo' ? 'Simulated' : 'Accepted by SES' : r.status === 'skipped' ? 'Skipped' : r.status === 'failed' ? 'Not sent' : 'Check sending outcome'}</strong><span className="block text-muted">{r.message}</span></li>)}</ul></div> : <Button className="mt-4" variant="ink" disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { const r = await api<{ results: ReminderResult[] }>('/m/payment-reminders', { method: 'POST', body: { dropId: drop.dropId, refs: orders.map(o => o.ref), requestId } }); setResults(r.results); onSent(); }
      catch (e) { setError(message(e)); }
      finally { setBusy(false); }
    }}><Mail aria-hidden="true" className="size-4"/>{busy ? 'Sending…' : `${mode === 'demo' ? 'Simulate' : 'Send'} ${orders.length} reminder${orders.length === 1 ? '' : 's'}`}</Button>}
  </section>;
}
