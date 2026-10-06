'use client';

import type { Drop, RatePreset, VerificationMode } from '@dropdeck/shared';
import { Plus, X } from 'lucide-react';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, Input, Textarea } from '../../components/ui/input';
import { Segmented } from '../../components/ui/segmented';
import { Skeleton } from '../../components/ui/skeleton';
import { Stepper } from '../../components/ui/stepper';
import { api } from '../../lib/api';
import { loadConfig } from '../../lib/config';
import { time } from '../../lib/format';
import { ImagePicker } from './ImagePicker';
import { ViewHeader, type ConsoleCtx } from './shared';

interface VariantRow { id?: string; name: string; stock: string; price: string }

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card className="flex flex-col gap-3.5 rounded-[20px] p-4">
      <div className="flex items-center justify-between"><h2 className="font-display text-[17px] font-bold">{title}</h2>{aside}</div>
      {children}
    </Card>
  );
}

const QUEUE_OPTIONS = ['5', '10', '15', '30'] as const;
const LENGTH_OPTIONS = ['30', '60', '120', 'custom'] as const;

export function DropEditor({ ctx, drop, loading }: { ctx: ConsoleCtx; drop?: Drop; loading?: boolean }) {
  if (loading) return <div className="flex flex-col gap-3 p-4 lg:p-8"><Skeleton className="h-12" /><Skeleton className="h-64" /></div>;
  return <Editor key={drop?.dropId ?? 'new'} ctx={ctx} drop={drop} />;
}

function Editor({ ctx, drop: d }: { ctx: ConsoleCtx; drop?: Drop }) {
  const scheduled = d?.state === 'Scheduled';
  const defaultOpen = new Date(Date.now() + 24 * 3600_000);
  defaultOpen.setMinutes(0, 0, 0);
  const initialLength = d ? String(Math.round((Date.parse(d.endAt) - Date.parse(d.openAt)) / 60_000)) : '60';

  const [title, setTitle] = useState(d?.title ?? '');
  const [description, setDescription] = useState(d?.description ?? '');
  const [imageUrl, setImageUrl] = useState<string | undefined>(d?.imageUrl);
  const [openAt, setOpenAt] = useState(toLocalInput(d?.openAt ?? defaultOpen.toISOString()));
  const [lengthMin, setLengthMin] = useState(initialLength);
  const [customLength, setCustomLength] = useState(!['30', '60', '120'].includes(initialLength));
  const [entryWindowMin, setEntryWindowMin] = useState(String(d?.entryWindowMin ?? 15));
  const [variants, setVariants] = useState<VariantRow[]>(
    d?.variants.map((v) => ({ id: v.id, name: v.name, stock: String(v.stock), price: (v.priceCents / 100).toFixed(2) })) ?? [{ name: '', stock: '', price: '' }],
  );
  const [perBuyerLimit, setPerBuyerLimit] = useState(d?.perBuyerLimit ?? 2);
  const [holdMin, setHoldMin] = useState((d?.holdSec ?? 300) / 60);
  const [verification, setVerification] = useState<VerificationMode>(d?.verification ?? 'email');
  const [ratePreset, setRatePreset] = useState<RatePreset>(d?.ratePreset ?? 'normal');
  const [busy, setBusy] = useState<'save' | 'schedule' | null>(null);
  const [testMail, setTestMail] = useState(false);
  useEffect(() => { loadConfig().then((c) => setTestMail(c.mailMode !== 'ses')).catch(() => undefined); }, []);

  const setVariant = (i: number, patch: Partial<VariantRow>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const units = variants.reduce((n, v) => n + (Number(v.stock) || 0), 0);
  const open = new Date(openAt);
  const valid = !Number.isNaN(open.getTime());
  const queueOpens = valid ? new Date(open.getTime() - Number(entryWindowMin) * 60_000) : null;
  const closes = valid ? new Date(open.getTime() + Number(lengthMin) * 60_000) : null;

  const save = async (then: 'save' | 'schedule') => {
    const body: Record<string, unknown> = {
      title,
      description,
      imageUrl: imageUrl ?? (d ? null : undefined),
      endAt: closes?.toISOString(),
      perBuyerLimit,
      holdSec: Math.round(holdMin * 60),
      verification,
      ratePreset,
    };
    // A scheduled drop's times and stock are baked into its schedule and stock shards (see merchant-api).
    if (!scheduled) {
      Object.assign(body, {
        openAt: open.toISOString(),
        entryWindowMin: Number(entryWindowMin),
        variants: variants.map((v) => ({ ...(v.id ? { id: v.id } : {}), name: v.name, stock: Number(v.stock), priceCents: Math.round(Number(v.price) * 100) })),
      });
    }
    setBusy(then);
    try {
      const saved = d
        ? await api<Drop>(`/m/drops/${d.dropId}`, { method: 'PATCH', body })
        : await api<Drop>('/m/drops', { method: 'POST', body });
      if (then === 'schedule') {
        try {
          await api(`/m/drops/${saved.dropId}/schedule`, { method: 'POST' });
        } catch (err) {
          // The draft is saved; stay on it (by id, so saving again updates it rather than making a second one).
          ctx.onError(err);
          await ctx.refresh();
          if (!d) ctx.go({ view: 'edit', id: saved.dropId });
          return;
        }
        toast.success('Scheduled. Share the link from your drops list.');
      } else {
        toast.success(d ? 'Changes saved' : 'Draft saved');
      }
      await ctx.refresh();
      ctx.go({ view: 'drops' });
    } catch (err) {
      ctx.onError(err);
    } finally {
      setBusy(null);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(scheduled ? 'save' : (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'schedule' ? 'schedule' : 'save');
  };

  return (
    <form onSubmit={submit} className="pb-36">
      <ViewHeader title={d ? 'Edit drop' : 'New drop'} back={() => window.history.back()} />
      <div className="grid gap-3.5 px-4 pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start lg:px-8">
        <div className="flex flex-col gap-3.5">
          {scheduled && <p className="rounded-2xl bg-info-tint px-4 py-3 text-sm font-semibold text-info">This drop is scheduled. To change its time, items or stock, unschedule it first.</p>}
          <Section title="Photo">
            <ImagePicker kind="drop" label="Drop photo" value={imageUrl} onChange={setImageUrl} help="JPG, PNG or WebP. It is resized on your device before uploading." />
          </Section>
          <Section title="Basics">
            <Field label="Title"><Input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Saturday sourdough" /></Field>
            <Field label="Description"><Textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is it, how many, and how buyers get it." /></Field>
          </Section>
          <Section title="When">
            <Field label="Draw time" help="Everyone in the queue by then gets a random place.">
              <Input type="datetime-local" required disabled={scheduled} value={openAt} onChange={(e) => setOpenAt(e.target.value)} />
            </Field>
            <div className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Queue opens before the draw</span>
              <Segmented label="Queue opens before the draw" disabled={scheduled} value={(QUEUE_OPTIONS as readonly string[]).includes(entryWindowMin) ? entryWindowMin : '15'} onChange={setEntryWindowMin} options={QUEUE_OPTIONS.map((m) => ({ value: m, label: `${m} min` }))} />
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Drop runs for</span>
              <Segmented
                label="Drop runs for"
                value={customLength ? 'custom' : lengthMin as (typeof LENGTH_OPTIONS)[number]}
                onChange={(v) => { if (v === 'custom') setCustomLength(true); else { setCustomLength(false); setLengthMin(v); } }}
                options={LENGTH_OPTIONS.map((m) => ({ value: m, label: m === 'custom' ? 'Custom' : Number(m) >= 60 ? `${Number(m) / 60} hr` : `${m} min` }))}
              />
              {customLength && <Input type="number" min={1} max={1440} required value={lengthMin} onChange={(e) => setLengthMin(e.target.value)} aria-label="Length in minutes" />}
            </div>
            {queueOpens && closes && <p className="text-[13px] text-muted">Queue opens {time(queueOpens.getTime())} · draw {time(open.getTime())} · closes {time(closes.getTime())}</p>}
          </Section>
        </div>

        <div className="flex flex-col gap-3.5">
          <Section title="Items" aside={<span className="text-[13px] text-muted">{units} units in total</span>}>
            <fieldset disabled={scheduled} className="flex flex-col gap-3">
              {variants.map((v, i) => (
                <div key={i} className="flex flex-col gap-2.5 rounded-[14px] border border-line p-3">
                  <div className="flex items-end gap-2">
                    <Field label="Name" className="flex-1 text-xs"><Input className="h-11" required maxLength={60} value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} placeholder="Country loaf" /></Field>
                    {variants.length > 1 && (
                      <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${v.name || 'item'}`} onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}><X /></Button>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <Field label="Stock" className="text-xs"><Input className="h-11" type="number" inputMode="numeric" required min={1} max={10000} value={v.stock} onChange={(e) => setVariant(i, { stock: e.target.value })} /></Field>
                    <Field label="Price (S$)" className="text-xs"><Input className="h-11" type="number" inputMode="decimal" required min={0} step="0.01" value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} /></Field>
                  </div>
                </div>
              ))}
              {variants.length < 10 && (
                <button type="button" onClick={() => setVariants((vs) => [...vs, { name: '', stock: '', price: '' }])} className="flex h-12 cursor-pointer items-center justify-center gap-1.5 rounded-[14px] border-[1.5px] border-dashed border-field text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50">
                  <Plus className="size-4" strokeWidth={2.4} />Add an item
                </button>
              )}
            </fieldset>
          </Section>
          <Section title="Rules">
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5"><strong className="text-[15px]">Limit per buyer</strong><span className="text-[13px] text-muted">Across all items</span></span>
              <Stepper label="Limit" value={perBuyerLimit} min={1} max={10} onChange={setPerBuyerLimit} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="flex flex-col gap-0.5"><strong className="text-[15px]">Hold time</strong><span className="text-[13px] text-muted">To confirm after reserving</span></span>
              <Stepper label="Hold time" value={holdMin} min={2} max={15} onChange={setHoldMin} format={(n) => `${n} min`} />
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Buyer check</span>
              <Segmented label="Buyer check" value={verification} onChange={setVerification} options={[{ value: 'email', label: 'Email code' }, { value: 'off', label: 'Off' }]} />
              <span className="text-[13px] font-medium text-muted">
                {verification === 'email' ? 'A code is emailed only after someone reserves, never to the whole queue.' : 'Anyone can check out with any email address.'}
                {verification === 'email' && testMail && ' Test mode: buyers see their code on screen.'}
              </span>
            </div>
            <div className="flex flex-col gap-1.5 text-sm font-semibold">
              <span>Admission pace</span>
              <Segmented label="Admission pace" value={ratePreset} onChange={setRatePreset} options={[{ value: 'gentle', label: 'Gentle' }, { value: 'normal', label: 'Normal' }, { value: 'fast', label: 'Fast' }]} />
              <span className="text-[13px] font-medium text-muted">How quickly people are let in from the queue.</span>
            </div>
          </Section>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface lg:left-[260px]">
        <div className="mx-auto flex max-w-[1120px] gap-2.5 px-4 pt-3 pb-[max(1.75rem,env(safe-area-inset-bottom))] lg:justify-end lg:px-8 lg:pb-4">
          {scheduled ? (
            <Button type="submit" variant="ink" size="lg" className="flex-1 lg:flex-none" disabled={busy !== null}>{busy ? 'Saving…' : 'Save changes'}</Button>
          ) : (
            <>
              <Button type="submit" name="then" value="save" variant="outline" size="lg" className="flex-1 lg:flex-none" disabled={busy !== null}>{busy === 'save' ? 'Saving…' : 'Save draft'}</Button>
              <Button type="submit" name="then" value="schedule" variant="volt" size="lg" className="flex-[1.3] font-extrabold lg:flex-none" disabled={busy !== null}>{busy === 'schedule' ? 'Scheduling…' : 'Schedule drop'}</Button>
            </>
          )}
        </div>
      </div>
    </form>
  );
}
