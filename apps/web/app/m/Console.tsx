'use client';

// Types only from @dropdeck/shared: its index also pulls in node:crypto, which must stay out of the browser bundle.
import type { Drop, MerchantProfile, Order, OrderStatus, RatePreset, VerificationMode } from '@dropdeck/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError, apiText } from '../../lib/api';
import { clearSession, getAccessToken, signedInEmail, signIn, signOut } from '../../lib/auth';
import { loadConfig } from '../../lib/config';

type View = { kind: 'list' } | { kind: 'profile' } | { kind: 'edit'; drop?: Drop } | { kind: 'orders'; drop: Drop };

const price = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dropUrl = (d: Drop) => `/d/${d.tenantId}/${d.dropId}/`;

/** Mirrors isLockedForEdit in packages/shared/src/lifecycle.ts. */
const entryOpened = (d: Drop) => Date.now() >= Date.parse(d.openAt) - d.entryWindowMin * 60_000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function Console() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    getAccessToken().then((t) => {
      setSignedIn(Boolean(t));
      setReady(true);
    });
  }, []);

  if (!ready) return <main><p className="muted">Loading…</p></main>;
  if (!signedIn) {
    return (
      <main>
        <h1>Merchant console</h1>
        <p className="muted">Create a drop, schedule it, and share one link. Buyers need no account.</p>
        <button onClick={() => signIn().catch((e) => alert(message(e)))}>Sign in or create an account</button>
      </main>
    );
  }
  return <SignedIn />;
}

function SignedIn() {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [profile, setProfile] = useState<MerchantProfile | null | undefined>(undefined);
  const [drops, setDrops] = useState<Drop[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handle = useCallback((e: unknown) => {
    if (e instanceof ApiRequestError && e.status === 401) {
      clearSession(); // otherwise a token the API rejects (not just an expired one) reloads forever
      window.location.reload();
      return;
    }
    setError(message(e));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([api<MerchantProfile | null>('/m/profile'), api<Drop[]>('/m/drops')]);
      setProfile(p);
      setDrops(d);
      if (!p) setView({ kind: 'profile' });
    } catch (e) {
      handle(e);
    }
  }, [handle]);

  useEffect(() => { void refresh(); }, [refresh]);

  const done = () => {
    setView({ kind: 'list' });
    setError(null);
    void refresh();
  };

  return (
    <main className="wide">
      <header className="bar">
        <div>
          <h1>{profile?.name ?? 'Merchant console'}</h1>
          <span className="muted">{signedInEmail()}</span>
        </div>
        <nav>
          <button className="ghost" onClick={() => setView({ kind: 'profile' })}>Shop profile</button>
          <button className="ghost" onClick={() => void signOut()}>Sign out</button>
        </nav>
      </header>
      {error && <p className="error" role="alert">{error}</p>}

      {view.kind === 'profile' && profile !== undefined && (
        <ProfileForm profile={profile} onSaved={done} onCancel={profile ? () => setView({ kind: 'list' }) : undefined} onError={handle} />
      )}
      {view.kind === 'edit' && <DropEditor drop={view.drop} onSaved={done} onCancel={() => setView({ kind: 'list' })} onError={handle} />}
      {view.kind === 'orders' && <OrdersView drop={view.drop} onBack={done} onError={handle} />}
      {view.kind === 'list' && (
        <DropList
          drops={drops}
          onEdit={(drop) => setView({ kind: 'edit', drop })}
          onOrders={(drop) => setView({ kind: 'orders', drop })}
          onNew={() => setView({ kind: 'edit' })}
          onChanged={done}
          onError={handle}
        />
      )}
    </main>
  );
}

function ProfileForm(props: { profile: MerchantProfile | null; onSaved: () => void; onCancel?: () => void; onError: (e: unknown) => void }) {
  const p = props.profile;
  const [name, setName] = useState(p?.name ?? '');
  const [paynow, setPaynow] = useState(p?.paynow ?? '');
  const [note, setNote] = useState(p?.fulfilmentNote ?? '');
  const [colour, setColour] = useState(p?.colour ?? '#1f6feb');
  const [busy, setBusy] = useState(false);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/m/profile', { method: 'PUT', body: { name, slug: p?.slug, paynow, fulfilmentNote: note, colour, logoUrl: p?.logoUrl } });
      props.onSaved();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h2>{p ? 'Shop profile' : 'Set up your shop'}</h2>
      <label>Shop name<input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>
        PayNow mobile or UEN
        <input value={paynow} onChange={(e) => setPaynow(e.target.value)} placeholder="+65 9123 4567 or 201912345A" />
        <small className="muted">Shown to buyers on their confirmation. DropDeck never handles the payment.</small>
      </label>
      <label>
        Collection or delivery note
        <textarea maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Self-collect at Tiong Bahru, Sat 2–5pm" />
      </label>
      <label className="inline">Brand colour<input type="color" value={colour} onChange={(e) => setColour(e.target.value)} /></label>
      <div className="actions">
        <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        {props.onCancel && <button type="button" className="ghost" onClick={props.onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function DropList(props: {
  drops: Drop[] | null;
  onEdit: (d: Drop) => void;
  onOrders: (d: Drop) => void;
  onNew: () => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (d: Drop, action: 'schedule' | 'unschedule' | 'cancel' | 'duplicate' | 'delete') => {
    if (action === 'cancel' && !confirm(`Cancel "${d.title}"? Buyers will see that it was cancelled.`)) return;
    if (action === 'delete' && !confirm(`Delete the draft "${d.title}"?`)) return;
    setBusy(d.dropId);
    try {
      if (action === 'delete') await api(`/m/drops/${d.dropId}`, { method: 'DELETE' });
      else await api(`/m/drops/${d.dropId}/${action}`, { method: 'POST' });
      props.onChanged();
    } catch (e) {
      props.onError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!props.drops) return <p className="muted">Loading drops…</p>;
  return (
    <section>
      <div className="bar">
        <h2>Drops</h2>
        <button onClick={props.onNew}>New drop</button>
      </div>
      {props.drops.length === 0 && <p className="muted">No drops yet. Create one, then schedule it to get a shareable link.</p>}
      {props.drops.map((d) => {
        const units = d.variants.reduce((n, v) => n + v.stock, 0);
        const editable = d.state === 'Draft' || (d.state === 'Scheduled' && !entryOpened(d));
        return (
          <article key={d.dropId} className="card drop">
            <div className="bar">
              <div>
                <strong>{d.title}</strong> <span className={`badge ${d.state.toLowerCase()}`}>{d.state}</span>
                <div className="muted">{when(d.openAt)} · {units} units · {d.variants.map((v) => `${v.name} ${price(v.priceCents)}`).join(', ')}</div>
              </div>
            </div>
            <div className="actions">
              {d.state !== 'Draft' && <a className="button ghost" href={dropUrl(d)} target="_blank" rel="noreferrer">Open page</a>}
              {d.state !== 'Draft' && (
                <button className="ghost" onClick={() => void navigator.clipboard.writeText(new URL(dropUrl(d), window.location.origin).toString())}>Copy link</button>
              )}
              {(d.state === 'Live' || d.state === 'Closed' || d.state === 'Cancelled') && (
                <button onClick={() => props.onOrders(d)}>{d.state === 'Live' ? 'Live view & orders' : 'Orders & report'}</button>
              )}
              {editable && <button className="ghost" onClick={() => props.onEdit(d)}>Edit</button>}
              {d.state === 'Draft' && <button disabled={busy === d.dropId} onClick={() => void act(d, 'schedule')}>Schedule</button>}
              {d.state === 'Scheduled' && !entryOpened(d) && (
                <button className="ghost" disabled={busy === d.dropId} onClick={() => void act(d, 'unschedule')}>Unschedule</button>
              )}
              {(d.state === 'Scheduled' || d.state === 'Live') && (
                <button className="ghost danger" disabled={busy === d.dropId} onClick={() => void act(d, 'cancel')}>Cancel drop</button>
              )}
              <button className="ghost" disabled={busy === d.dropId} onClick={() => void act(d, 'duplicate')}>Duplicate</button>
              {d.state === 'Draft' && <button className="ghost danger" disabled={busy === d.dropId} onClick={() => void act(d, 'delete')}>Delete</button>}
            </div>
          </article>
        );
      })}
    </section>
  );
}

interface VariantRow { id?: string; name: string; stock: string; price: string }

/** ISO → value for <input type="datetime-local"> in the browser's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function DropEditor(props: { drop?: Drop; onSaved: () => void; onCancel: () => void; onError: (e: unknown) => void }) {
  const d = props.drop;
  const scheduled = d?.state === 'Scheduled';
  const defaultOpen = new Date(Date.now() + 24 * 3600_000);
  defaultOpen.setMinutes(0, 0, 0);

  const [title, setTitle] = useState(d?.title ?? '');
  const [description, setDescription] = useState(d?.description ?? '');
  const [imageUrl, setImageUrl] = useState(d?.imageUrl ?? '');
  const [openAt, setOpenAt] = useState(toLocalInput(d?.openAt ?? defaultOpen.toISOString()));
  const [lengthMin, setLengthMin] = useState(d ? String(Math.round((Date.parse(d.endAt) - Date.parse(d.openAt)) / 60_000)) : '30');
  const [variants, setVariants] = useState<VariantRow[]>(
    d?.variants.map((v) => ({ id: v.id, name: v.name, stock: String(v.stock), price: (v.priceCents / 100).toFixed(2) })) ??
      [{ name: '', stock: '', price: '' }],
  );
  const [perBuyerLimit, setPerBuyerLimit] = useState(String(d?.perBuyerLimit ?? 2));
  const [holdMin, setHoldMin] = useState(String((d?.holdSec ?? 300) / 60));
  const [verification, setVerification] = useState<VerificationMode>(d?.verification ?? 'email');
  const [ratePreset, setRatePreset] = useState<RatePreset>(d?.ratePreset ?? 'normal');
  const [entryWindowMin, setEntryWindowMin] = useState(String(d?.entryWindowMin ?? 15));
  const [busy, setBusy] = useState(false);
  const [testMail, setTestMail] = useState(false);
  useEffect(() => { loadConfig().then((c) => setTestMail(c.mailMode !== 'ses')).catch(() => undefined); }, []);

  const setVariant = (i: number, patch: Partial<VariantRow>) => setVariants((vs) => vs.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const open = new Date(openAt);
    const body: Record<string, unknown> = {
      title,
      description,
      ...(imageUrl ? { imageUrl } : {}),
      endAt: new Date(open.getTime() + Number(lengthMin) * 60_000).toISOString(),
      perBuyerLimit: Number(perBuyerLimit),
      holdSec: Math.round(Number(holdMin) * 60),
      verification,
      ratePreset,
    };
    // A scheduled drop's times and stock are baked into its schedule and stock shards (see merchant-api).
    if (!scheduled) {
      Object.assign(body, {
        openAt: open.toISOString(),
        entryWindowMin: Number(entryWindowMin),
        variants: variants.map((v) => ({
          ...(v.id ? { id: v.id } : {}),
          name: v.name,
          stock: Number(v.stock),
          priceCents: Math.round(Number(v.price) * 100),
        })),
      });
    }
    setBusy(true);
    try {
      if (d) await api(`/m/drops/${d.dropId}`, { method: 'PATCH', body });
      else await api('/m/drops', { method: 'POST', body });
      props.onSaved();
    } catch (err) {
      props.onError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={save}>
      <h2>{d ? 'Edit drop' : 'New drop'}</h2>
      {scheduled && <p className="muted">This drop is scheduled. To change its time, variants or stock, unschedule it first.</p>}
      <label>Title<input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Saturday sourdough" /></label>
      <label>Description<textarea maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></label>
      <label>Image URL (optional)<input type="url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} /></label>

      <div className="row">
        <label>Opens at<input type="datetime-local" required disabled={scheduled} value={openAt} onChange={(e) => setOpenAt(e.target.value)} /></label>
        <label>Length (minutes)<input type="number" min={1} max={1440} required value={lengthMin} onChange={(e) => setLengthMin(e.target.value)} /></label>
        <label>Queue opens (min before)<input type="number" min={0} max={60} required disabled={scheduled} value={entryWindowMin} onChange={(e) => setEntryWindowMin(e.target.value)} /></label>
      </div>

      <fieldset disabled={scheduled}>
        <legend>Variants</legend>
        {variants.map((v, i) => (
          <div className="row variant" key={i}>
            <label>Name<input required maxLength={60} value={v.name} onChange={(e) => setVariant(i, { name: e.target.value })} /></label>
            <label>Stock<input type="number" required min={1} max={10000} value={v.stock} onChange={(e) => setVariant(i, { stock: e.target.value })} /></label>
            <label>Price (S$)<input type="number" required min={0} step="0.01" value={v.price} onChange={(e) => setVariant(i, { price: e.target.value })} /></label>
            {variants.length > 1 && (
              <button type="button" className="ghost" aria-label="Remove variant" onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}>Remove</button>
            )}
          </div>
        ))}
        {variants.length < 10 && (
          <button type="button" className="ghost" onClick={() => setVariants((vs) => [...vs, { name: '', stock: '', price: '' }])}>Add variant</button>
        )}
      </fieldset>

      <div className="row">
        <label>Limit per buyer<input type="number" min={1} max={10} required value={perBuyerLimit} onChange={(e) => setPerBuyerLimit(e.target.value)} /></label>
        <label>Hold (minutes)<input type="number" min={2} max={15} required value={holdMin} onChange={(e) => setHoldMin(e.target.value)} /></label>
        <label>
          Buyer check
          <select value={verification} onChange={(e) => setVerification(e.target.value as VerificationMode)}>
            <option value="email">Email code at checkout</option>
            <option value="off">None</option>
          </select>
          {verification === 'email' && testMail && <small className="muted">Test mode: no email is sent yet; buyers see their code on screen.</small>}
        </label>
        <label>
          Admission pace
          <select value={ratePreset} onChange={(e) => setRatePreset(e.target.value as RatePreset)}>
            <option value="gentle">Gentle</option>
            <option value="normal">Normal</option>
            <option value="fast">Fast</option>
          </select>
        </label>
      </div>

      <div className="actions">
        <button disabled={busy}>{busy ? 'Saving…' : d ? 'Save changes' : 'Create draft'}</button>
        <button type="button" className="ghost" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}

interface Live {
  state: Drop['state'];
  variants: Array<{ id: string; name: string; stock: number; out: number }>;
  activeHolds: number;
  orders: number;
  unitsOrdered: number;
  queue: { earlyCount: number | null; lateTickets: number };
}

interface Report {
  stock: number;
  orders: number;
  units: { ordered: number; paid: number; unpaid: number; noShow: number };
  revenueCents: { ordered: number; paid: number; outstanding: number };
  sellThrough: number;
  secondsToSellOut: number | null;
  byVariant: Array<{ id: string; name: string; stock: number; ordered: number; paid: number }>;
}

const STATUS_LABEL: Record<OrderStatus, string> = { confirmed: 'Awaiting payment', paid: 'Paid', 'no-show': 'No-show' };

/** Live numbers while the drop runs; reconciliation (paid / no-show), report and CSV afterwards. */
function OrdersView(props: { drop: Drop; onBack: () => void; onError: (e: unknown) => void }) {
  const { drop, onError } = props;
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, r, l] = await Promise.all([
        api<Order[]>(`/m/drops/${drop.dropId}/orders`),
        api<Report>(`/m/drops/${drop.dropId}/report`),
        drop.state === 'Live' ? api<Live>(`/m/drops/${drop.dropId}/live`) : Promise.resolve(null),
      ]);
      setOrders(o);
      setReport(r);
      setLive(l);
    } catch (e) {
      onError(e);
    }
  }, [drop, onError]);

  useEffect(() => {
    void load();
    if (drop.state !== 'Live') return;
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [drop.state, load]);

  const setStatus = async (o: Order, status: OrderStatus) => {
    setSaving(o.ref);
    try {
      const updated = await api<Order>(`/m/orders/${o.ref}`, { method: 'PATCH', body: { dropId: drop.dropId, status } });
      setOrders((os) => os?.map((x) => (x.ref === o.ref ? updated : x)) ?? null);
      setReport(await api<Report>(`/m/drops/${drop.dropId}/report`));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(null);
    }
  };

  const download = async () => {
    try {
      const csv = await apiText(`/m/drops/${drop.dropId}/export.csv`);
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${drop.title.replace(/[^\w-]+/g, '-').toLowerCase()}-orders.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      onError(e);
    }
  };

  return (
    <section>
      <div className="bar">
        <h2>{drop.title} <span className={`badge ${drop.state.toLowerCase()}`}>{drop.state}</span></h2>
        <nav>
          <button className="ghost" onClick={download} disabled={!orders?.length}>Download CSV</button>
          <button className="ghost" onClick={props.onBack}>Back</button>
        </nav>
      </div>

      {live && (
        <div className="stats">
          {live.variants.map((v) => (
            <div key={v.id} className="stat"><span className="muted">{v.name}</span><strong>{v.out} / {v.stock}</strong><small className="muted">held or sold</small></div>
          ))}
          <div className="stat"><span className="muted">Holds open</span><strong>{live.activeHolds}</strong><small className="muted">buyers checking out</small></div>
          <div className="stat"><span className="muted">In the queue</span><strong>{(live.queue.earlyCount ?? 0) + live.queue.lateTickets}</strong><small className="muted">approximate</small></div>
        </div>
      )}

      {report && (
        <div className="stats">
          <div className="stat"><span className="muted">Orders</span><strong>{report.orders}</strong><small className="muted">{report.units.ordered} of {report.stock} units ({Math.round(report.sellThrough * 100)}%)</small></div>
          <div className="stat"><span className="muted">Paid</span><strong>{price(report.revenueCents.paid)}</strong><small className="muted">{report.units.paid} units</small></div>
          <div className="stat"><span className="muted">Awaiting payment</span><strong>{price(report.revenueCents.outstanding)}</strong><small className="muted">{report.units.unpaid} units</small></div>
          <div className="stat"><span className="muted">No-shows</span><strong>{report.units.noShow}</strong><small className="muted">units</small></div>
          {report.secondsToSellOut !== null && (
            <div className="stat"><span className="muted">Sold out in</span><strong>{Math.floor(report.secondsToSellOut / 60)}m {report.secondsToSellOut % 60}s</strong><small className="muted">from opening</small></div>
          )}
        </div>
      )}

      {!orders && <p className="muted">Loading orders…</p>}
      {orders && orders.length === 0 && <p className="muted">No orders yet.</p>}
      {orders && orders.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Ref</th><th>Buyer</th><th>Item</th><th className="num">Amount</th><th>Status</th></tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.ref}>
                  <td><code>{o.ref}</code></td>
                  <td>{o.name}<br /><small className="muted">{o.email}</small></td>
                  <td>{o.qty} × {o.variantName}</td>
                  <td className="num">{price(o.amountCents)}</td>
                  <td>
                    <select value={o.status} disabled={saving === o.ref} onChange={(e) => void setStatus(o, e.target.value as OrderStatus)} aria-label={`Status of ${o.ref}`}>
                      {(Object.keys(STATUS_LABEL) as OrderStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
