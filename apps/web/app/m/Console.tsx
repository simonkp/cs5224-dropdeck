'use client';

// Types only from @dropdeck/shared: its index also pulls in node:crypto, which must stay out of the browser bundle.
import type { Drop, MerchantProfile, RatePreset, VerificationMode } from '@dropdeck/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, ApiRequestError } from '../../lib/api';
import { clearSession, getAccessToken, signedInEmail, signIn, signOut } from '../../lib/auth';

type View = { kind: 'list' } | { kind: 'profile' } | { kind: 'edit'; drop?: Drop };

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
      {view.kind === 'list' && (
        <DropList drops={drops} onEdit={(drop) => setView({ kind: 'edit', drop })} onNew={() => setView({ kind: 'edit' })} onChanged={done} onError={handle} />
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
