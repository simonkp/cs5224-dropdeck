/** Development fixtures. Imported only from the compile-time development branch. No cloud requests. */
import type { Drop, MerchantProfile, Order, PublicDrop } from '@dropdeck/shared';
import { buildReport, ordersCsv } from '../../../../services/merchant-api/src/reports';
import { saveSession } from '../../app/d/buyer';
import { operatorPreview } from './operations';
import { analyticsCapabilities } from '@dropdeck/shared/plans';
import { orderMatchesStatus, summarizeSales, trackingOf } from '@dropdeck/shared/merchant-analytics';
import { reminderProblem, REMINDER_BATCH_LIMIT, REMINDER_COOLDOWN_MS, type PaymentReminder, type ReminderOrder, type ReminderResult } from '@dropdeck/shared/payment-reminders';

const KEY = 'dd.preview.v2';
const iso = (ms: number) => new Date(ms).toISOString();
const scenarios = ['countdown', 'entry', 'drawing', 'queued', 'admitted', 'held', 'code-sent', 'confirmed', 'reserved', 'expired', 'closed', 'cancelled', 'missing', 'kopi', 'hue', 'turn-expired', 'closed-hold', 'cancelled-order', 'delayed'];
interface Data { profile: MerchantProfile; drops: Drop[]; orders: ReminderOrder[]; reminderHistory?:Record<string,Array<PaymentReminder&{actor:string}>>; reminderRequests?:Record<string,ReminderResult[]>; history?: Record<string, Array<Record<string,unknown>>>; holds: Record<string, { dropId: string; expiresAt: string; variantId: string; qty: number; sentAt?: number; sends: number; attempts: number; email?: string; confirmed?: boolean; orderRef?: string }>; seeded: string[] }
let data: Data;
let installed = false;
const persist = () => localStorage.setItem(KEY, JSON.stringify(data));
function initial(): Data {
  const now = Date.now();
  const base: Drop = { tenantId: 'preview', dropId: 'live', state: 'Live', title: 'Saturday sourdough', imageUrl: '/landing/baguettes.jpg', description: 'Slow-fermented for 36 hours. Baked fresh in Tiong Bahru. Small batches, worth the wait.', variants: [{ id: 'country', name: 'Country loaf', stock: 50, priceCents: 1200 }, { id: 'olive', name: 'Olive & rosemary', stock: 30, priceCents: 1400 }], openAt: iso(now - 900000), endAt: iso(now + 7200000), entryWindowMin: 15, graceSec: 30, perBuyerLimit: 2, holdSec: 300, admitWindowSec: 120, ratePreset: 'normal', verification: 'email', shardCount: 4, createdAt: iso(now), updatedAt: iso(now), version: 1 };
  const drops: Drop[] = [base, { ...base, dropId: 'scheduled', state: 'Scheduled', title: 'Next weekend bake', openAt: iso(now + 86400000), endAt: iso(now + 90000000) }, { ...base, dropId: 'draft', state: 'Draft', title: 'The focaccia edit', openAt: iso(now + 172800000), endAt: iso(now + 176400000) }, { ...base, dropId: 'ended', state: 'Closed', title: 'Last weekend bake', openAt: iso(now - 86400000), endAt: iso(now - 82800000) }];
  const orders: Order[] = Array.from({ length: 31 }, (_, i) => ({ tenantId: 'preview', dropId: i < 25 ? 'live' : 'ended', ref: `DEMO${String(i + 1).padStart(4, '0')}`, holdId: `seed-${i}`, variantId: i % 2 ? 'olive' : 'country', variantName: i % 2 ? 'Olive & rosemary' : 'Country loaf', qty: 2, unitPriceCents: i % 2 ? 1400 : 1200, amountCents: i % 2 ? 2800 : 2400, name: ['Alex Tan', 'Jamie Lim', 'Sam Lee'][i % 3]!, email: `buyer${i + 1}@example.com`, status: i < 16 ? 'paid' : 'confirmed', createdAt: iso(now - i * 30000) }));
  return { profile: { tenantId: 'preview', name: 'Tiong Bahru Sourdough Co.', slug: 'tiong-bahru-sourdough', slugClaimed: true, tagline: 'Small batches. Slow mornings.', colour: '#b5651d', theme: 'light', tier: 'growth', paynow: 'DEMO — do not transfer', fulfilmentNote: 'Preview only. No purchase or payment is made.', listed: true }, drops, orders, holds: {}, seeded: [] };
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', date: new Date().toUTCString() } });
const error = (code: string, message: string, status = 400) => response({ code, message }, status);
function publicDrop(id: string): PublicDrop {
  const base = data.drops.find(d => d.dropId === id) ?? data.drops[0]!;
  const now = Date.now();
  const count = ['countdown', 'kopi', 'hue'].includes(id);
  const entry = id === 'entry';
  // Scenario times are stable across refresh; the seed timestamp lives in local storage.
  const stampKey = `dd.preview.time.${id}`;
  const start = Number(localStorage.getItem(stampKey) || now);
  localStorage.setItem(stampKey, String(start));
  const openAt = scenarios.includes(id) ? iso(start + (count ? 86400000 : entry ? 45000 : -120000)) : base.openAt;
  const merchant = id === 'kopi' ? { ...data.profile, name: 'Kopi Club', coverUrl: '/landing/coffee.jpg', colour: '#0f766e', theme: 'dark' as const } : id === 'hue' ? { ...data.profile, name: 'Hue Studio', coverUrl: '/landing/ceramics.jpg', colour: '#f2c94c', theme: 'light' as const } : data.profile;
  return { ...base, ...(id === 'kopi' ? { title: 'The weekend coffee club', imageUrl: '/landing/coffee.jpg', description: 'Small-batch roasts for your slow morning.' } : id === 'hue' ? { title: 'Made by hand. One of a kind.', imageUrl: '/landing/ceramics.jpg', description: 'A limited collection of everyday ceramics.' } : {}), dropId: id, merchant, openAt, entryOpensAt: iso(Date.parse(openAt) - base.entryWindowMin * 60000) };
}
function confirmation(id: string, h: Data['holds'][string]) {
  const d = publicDrop(id); const v = d.variants.find(v => v.id === h.variantId)!;
  return { state: 'confirmed', orderRef: h.orderRef ?? 'DEMO2026', dropTitle: d.title, variantName: v.name, qty: h.qty, amountCents: v.priceCents * h.qty, merchant: data.profile };
}
function seed(id: string) {
  if (data.seeded.includes(id)) return;
  data.seeded.push(id);
  if (['queued', 'drawing', 'admitted', 'reserved', 'turn-expired'].includes(id)) saveSession('preview', id, { stage: 'queued', ticket: id, r: id === 'queued' ? 0.8 : 0.1, ...(id === 'turn-expired' ? { admittedSeenAt: Date.now()-121000 } : {}) });
  if (['held', 'code-sent', 'confirmed', 'expired', 'closed-hold', 'cancelled-order'].includes(id)) {
    const h = { dropId: id, expiresAt: iso(Date.now() + (id === 'expired' ? -1000 : 300000)), variantId: 'country', qty: 2, sends: id === 'code-sent' ? 1 : 0, attempts: 0, ...(id === 'code-sent' ? { sentAt: Date.now(), email: 'alex@example.com' } : {}), confirmed: ['confirmed','cancelled-order'].includes(id) };
    data.holds[id] = h;
    saveSession('preview', id, ['confirmed','cancelled-order'].includes(id) ? { stage: 'confirmed', confirmation: confirmation(id, h) } : { stage: 'held', hold: id, holdId: id, expiresAt: h.expiresAt, variantId: h.variantId, qty: h.qty });
  }
  persist();
}
export function install() {
  if (installed) return;
  installed = true;
  try { data = JSON.parse(localStorage.getItem(KEY) || 'null') as Data; } catch { /* fresh fixtures */ }
  data ||= initial(); persist();
  const id = location.pathname.split('/')[3]; if (id) seed(id);
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    const p = url.pathname; const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (p === '/config.json') return response({ apiUrl: '/__local', stage: 'local-preview', mailMode: 'log', userPoolId: '', userPoolClientId: '', authDomain: '' });
    const match = p.match(/^\/d\/preview\/([^/]+)\/(drop|state)\.json$/);
    if (match) {
      const id = match[1]!; if (id === 'missing') return error('NOT_FOUND', 'Preview missing drop', 404);
      const d = publicDrop(id);
      if (match[2] === 'drop') return response(d);
      if (id === 'delayed') return error('UNAVAILABLE', 'Simulated delayed state', 503);
      return response({ state: (['closed','closed-hold'].includes(id) || (!scenarios.includes(id) && data.drops.find(d => d.dropId === id)?.state === 'Closed')) ? 'Closed' : (['cancelled','cancelled-order'].includes(id) || (!scenarios.includes(id) && data.drops.find(d => d.dropId === id)?.state === 'Cancelled')) ? 'Cancelled' : Date.now() < Date.parse(d.entryOpensAt) ? 'Scheduled' : 'Live', serverTime: iso(Date.now()), earlyCount: id === 'drawing' || Date.now() < Date.parse(d.openAt) ? null : 214, rThreshold: id === 'queued' ? 0.3 : 1, nWatermark: 100, soldOut: Object.fromEntries(d.variants.map(v => [v.id, id === 'reserved'])) });
    }
    if (/^\/s\/[^/]+\/shop.json$/.test(p)) return response({ tenantId: 'preview', merchant: data.profile, generatedAt: iso(Date.now()), drops: data.drops.filter(d => d.state !== 'Draft').map(d => ({ ...publicDrop(d.dropId), state: d.state, url: `/d/preview/${d.dropId}/`, fromPriceCents: 1200 })) });
    if (!p.startsWith('/__local/')) return original(input, init);
    const path = p.slice('/__local'.length);
    if(path==='/m/analytics'||path==='/m/analytics/export.csv') {
      const advanced=url.searchParams.get('advanced')==='1'||path.endsWith('.csv');
      const capabilities={tier:data.profile.tier,...analyticsCapabilities(data.profile.tier),enabled:true,reminderMode:'demo'};
      if(advanced&&!capabilities.advancedPreview)return error('PLAN_LIMIT','Advanced analytics preview is available only on Growth',402);
      const from=url.searchParams.get('from')??iso(Date.now()-6*86400000).slice(0,10);const to=url.searchParams.get('to')??iso(Date.now()).slice(0,10);
      if((Date.parse(to)-Date.parse(from))/86400000+1>(advanced?90:31))return error('VALIDATION','Select a shorter date range');
      const ds=data.drops.filter(d=>d.state!=='Draft'&&(!url.searchParams.get('dropId')||d.dropId===url.searchParams.get('dropId')));
      const report=summarizeSales(data.orders.filter(o=>ds.some(d=>d.dropId===o.dropId)),ds,from,to,advanced);
      if(path.endsWith('.csv'))return new Response(['day,orders,confirmed_sgd,recorded_paid_sgd',...report.days.map(d=>[d.day,d.orders,d.confirmedCents/100,d.paidCents/100].join(','))].join('\r\n'),{headers:{'content-type':'text/csv'}});
      return response({enabled:true,capabilities,advanced,preview:advanced,generatedAt:iso(Date.now()),from,to,scope:{drops:ds.length,availableDrops:ds.length,maxOrdersPerDrop:500,partial:false},...report});
    }
    if(path==='/m/payment-reminders'&&method==='POST') {
      if(!Array.isArray(body.refs)||!body.refs.length||body.refs.length>REMINDER_BATCH_LIMIT||typeof body.requestId!=='string')return error('VALIDATION','Choose up to 10 orders and provide a request ID');
      const drop=data.drops.find(d=>d.dropId===body.dropId);if(!drop)return error('NOT_FOUND','Drop not found',404);
      if(!data.profile.paynow?.trim())return error('VALIDATION','Add your shop’s PayNow payment instructions before sending reminders');
      data.reminderHistory??={};data.reminderRequests??={};
      const requestKey=`${drop.dropId}/${body.requestId}`;
      if(data.reminderRequests[requestKey])return response({mode:'demo',results:data.reminderRequests[requestKey]});
      const results:ReminderResult[]=body.refs.map(ref=>{
        const order=data.orders.find(o=>o.dropId===drop.dropId&&o.ref===ref);if(!order)return {ref:String(ref),status:'skipped',message:'Order not found.'};
        const problem=reminderProblem(order,drop);if(problem)return {ref:order.ref,status:'skipped',message:problem};
        order.paymentReminder={status:'accepted',attemptedAt:iso(Date.now()),nextAllowedAt:Date.now()+REMINDER_COOLDOWN_MS};
        data.reminderHistory![order.ref]=[{...order.paymentReminder,actor:'preview'},...(data.reminderHistory![order.ref]??[])];
        return {ref:order.ref,status:'accepted',message:'Simulated only. No email was sent.'};
      });data.reminderRequests[requestKey]=results;persist();return response({mode:'demo',results});
    }
    if(path==='/m/order-worklist')return response({enabled:true,rows:data.orders.filter(o=>o.dropId===url.searchParams.get('dropId')&&(!url.searchParams.get('payment')||trackingOf(o).paymentStatus===url.searchParams.get('payment'))&&(!url.searchParams.get('fulfillment')||trackingOf(o).fulfillmentStatus===url.searchParams.get('fulfillment')))});
    const trackingRoute=path.match(/^\/m\/orders\/([^/]+)\/(tracking|history)$/);
    if(trackingRoute){
      const o=data.orders.find(o=>o.ref===trackingRoute[1]);if(!o)return error('NOT_FOUND','Order not found',404);
      data.history??={};
      if(trackingRoute[2]==='history')return response({rows:data.history[o.ref]??[],partial:false,paymentReminders:{rows:data.reminderHistory?.[o.ref]??[],partial:false}});
      if((o.version??0)!==body.expectedVersion)return error('INVALID_STATE','Order changed. Refresh before saving again.',409);
      const after={...trackingOf(o),...(body.patch as object)};o.tracking=after;o.version=(o.version??0)+1;
      o.status=after.attendanceStatus==='no_show'?'no-show':after.paymentStatus==='paid'?'paid':'confirmed';
      data.history[o.ref]=[{at:iso(Date.now()),actor:'preview',after,version:o.version,reason:body.reason??''},...(data.history[o.ref]??[])];persist();return response(o);
    }
    if(path.startsWith('/admin/')) {
      const result=operatorPreview(path,url,data.profile,method,body);
      if(method==='PATCH'&&result.ok)persist();
      return result;
    }
    if (path === '/m/profile') { if (method === 'PUT') { data.profile = { ...data.profile, ...body }; persist(); } return response(data.profile); }
    if (path === '/m/uploads') { const raw = String(body.image); return response({ path: `data:image/${raw.startsWith('iVBOR') ? 'png' : raw.startsWith('/9j/') ? 'jpeg' : 'webp'};base64,${raw}` }); }
    if (path === '/m/usage') return response({ tier: 'growth', plan: { label: 'Preview', monthlySgd: 0, perDropSgd: 0, dropsPerMonth: null, unitsPerMonth: null, sessionsIncluded: null }, months: [{ month: iso(Date.now()).slice(0,7), drops: 1, cancelled: 0, sessions: 224, orders: 31 }] });
    if (path.startsWith('/m/slugs/')) return response({ available: true, problem: null });
    if (path === '/m/drops') {
      if (method === 'POST') { const d = { ...data.drops[0]!, ...body, dropId: crypto.randomUUID(), state: 'Draft' as const }; d.variants = d.variants.map((v,i) => ({ ...v, id: v.id || `item-${i}` })); data.drops.push(d); persist(); return response(d); }
      return response(data.drops);
    }
    if (path === '/m/overview') return response({ generatedAt: iso(Date.now()), summaries: data.drops.filter(d => (url.searchParams.get('ids') ?? '').split(',').includes(d.dropId)).map(d => { const os = data.orders.filter(o => o.dropId === d.dropId); return { dropId: d.dropId, stock: 80, reserved: os.reduce((n,o) => n+o.qty,0)+(d.state === 'Live' ? 12 : 0), orders: os.length, paidOrders: os.filter(o => orderMatchesStatus(o,'paid')).length, awaitingOrders: os.filter(o => orderMatchesStatus(o,'confirmed')).length, partial: false }; }) });
    const merchantDrop = path.match(/^\/m\/drops\/([^/]+)(?:\/(.+))?$/);
    if (merchantDrop) {
      const d = data.drops.find(d => d.dropId === merchantDrop[1]); if (!d) return error('NOT_FOUND', 'Drop not found', 404);
      const action = merchantDrop[2]; const os = data.orders.filter(o => o.dropId === d.dropId);
      if (action === 'orders') return response(os);
      if (action === 'report') return response(buildReport(d, os, { earlyCount: 214, lateTickets: 10 }));
      if (action === 'inventory') return response({state:d.state,generatedAt:iso(Date.now()),partial:false,ordersPartial:false,variants:d.variants.map(v=>{const confirmedUnits=os.filter(o=>o.variantId===v.id).reduce((n,o)=>n+o.qty,0);const out=Math.min(v.stock,confirmedUnits+6);return {...v,out,confirmedUnits,available:v.stock-out,complete:true};})});
      if (action === 'export.csv') return new Response(ordersCsv(os), { headers: { 'content-type': 'text/csv' } });
      if (action === 'live') return response({ state: d.state, variants: d.variants.map(v => ({ ...v, out: Math.min(v.stock, os.filter(o => o.variantId === v.id).reduce((n,o) => n+o.qty,0)+6) })), activeHolds: 7, orders: os.length, unitsOrdered: os.reduce((n,o) => n+o.qty,0), queue: { earlyCount: 214, lateTickets: 10 } });
      if (method === 'DELETE') data.drops = data.drops.filter(x => x !== d);
      if (method === 'PATCH') { Object.assign(d, body); d.variants = d.variants.map((v,i) => ({ ...v, id: v.id || `item-${i}` })); }
      if (action === 'schedule') d.state = 'Scheduled';
      if (action === 'unschedule') d.state = 'Draft';
      if (action === 'cancel') d.state = 'Cancelled';
      if (action === 'duplicate') data.drops.push({ ...d, dropId: crypto.randomUUID(), title: `${d.title} (copy)`, state: 'Draft' });
      persist(); return response(d);
    }
    if (path.startsWith('/m/orders/')) { const o = data.orders.find(o => o.ref === path.split('/').pop()); if (o) Object.assign(o, body); persist(); return response(o); }
    const buyer = path.match(/^\/api\/d\/preview\/([^/]+)\/(ticket|claim)$/);
    if (buyer) {
      const id = buyer[1]!;
      if (buyer[2] === 'ticket') return response({ ticket: id, r: 0.1 });
      if (id === 'turn-expired') return error('ADMISSION_EXPIRED', 'Your turn has passed');
      if (id === 'reserved') return error('SOLD_OUT', 'Everything is temporarily reserved');
      const holdId = crypto.randomUUID(); const h = { dropId: id, expiresAt: iso(Date.now() + 300000), variantId: String(body.variantId), qty: Number(body.qty), sends: 0, attempts: 0 };
      data.holds[holdId] = h; persist(); return response({ hold: holdId, holdId, ...h });
    }
    const hold = path.match(/^\/api\/holds\/([^/]+)(?:\/(.+))?$/);
    if (hold) {
      const h = data.holds[hold[1]!]; if (!h) return error('HOLD_EXPIRED', 'Hold not found');
      if (h.confirmed) return response(confirmation(h.dropId, h));
      if (Date.parse(h.expiresAt) <= Date.now()) return hold[2] ? error('HOLD_EXPIRED', 'Your hold expired') : response({ state: 'expired' });
      if (hold[2] === 'otp') {
        if (h.sends >= 3) return error('OTP_LOCKED', 'No resends left');
        if (h.sentAt && Date.now() - h.sentAt < 30000) return error('RATE_LIMITED', 'Wait before resending');
        h.email = String(body.email); h.sentAt = Date.now(); h.sends++; persist();
        return response({ sentTo: h.email.replace(/(.).+(@.*)/, '$1•••$2'), resendAfterSec: 30, sendsLeft: 3-h.sends, devCode: '123456' });
      }
      if (hold[2] === 'confirm') {
        if (h.attempts >= 5) return error('OTP_LOCKED', 'No attempts left');
        if (publicDrop(h.dropId).verification === 'email' && (String(body.code) !== '123456' || body.email !== h.email)) { h.attempts++; persist(); return error('OTP_INVALID', `Code or email incorrect; ${5-h.attempts} attempts left`); }
        h.confirmed = true; h.orderRef = `DEMO${String(data.orders.length+1).padStart(4,'0')}`;
        const d = publicDrop(h.dropId); const v = d.variants.find(v => v.id === h.variantId)!;
        data.orders.push({ tenantId: 'preview', dropId: h.dropId, ref: h.orderRef, holdId: hold[1]!, variantId: h.variantId, variantName: v.name, qty: h.qty, unitPriceCents: v.priceCents, amountCents: v.priceCents*h.qty, name: String(body.name), email: String(body.email), status: 'confirmed', createdAt: iso(Date.now()) });
        persist(); return response(confirmation(h.dropId,h));
      }
      return response({ state: 'active', ...h, codeSent: Boolean(h.sentAt), code: h.sentAt ? { sentTo: h.email?.replace(/(.).+(@.*)/, '$1•••$2'), resendAfterSec: Math.max(0, Math.ceil((h.sentAt+30000-Date.now())/1000)), sendsLeft: 3-h.sends, attemptsLeft: 5-h.attempts } : null });
    }
    return error('LOCAL_PREVIEW_UNSUPPORTED', 'This action needs the connected AWS environment.', 501);
  };
}
export function Gallery() {
  return <main className="mx-auto max-w-5xl px-5 py-12"><p className="text-sm font-bold text-muted">DROPDECK · DESIGN REVIEW</p><h1 className="mt-2 font-display text-5xl font-extrabold tracking-tight">Small batches.<br />A better drop.</h1><p className="my-5 max-w-xl text-muted">Real screens, simulated services. Explore the buyer journey and merchant workspace. Changes stay in this browser. Checkout code: 123456.</p><div className="my-8 flex flex-wrap gap-3">{[['/m/', 'Merchant console'], ['/m/?view=shop', 'Shop branding'], ['/s/tiong-bahru-sourdough/', 'Storefront']].map(([url,label]) => <a className="rounded-2xl bg-ink px-5 py-3 font-bold text-bg" href={url} key={url}>{label}</a>)}</div><h2 className="mb-4 font-display text-2xl font-bold">Buyer scenarios</h2><div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{scenarios.map((s,i) => <a key={s} className="rounded-3xl border border-line bg-surface p-5 hover:border-brand-text" href={`/d/preview/${s}/`}><span className="text-xs text-muted">{String(i+1).padStart(2,'0')}</span><strong className="mt-3 block capitalize">{s.replace('-', ' ')}</strong></a>)}</div><button className="mt-8 rounded-xl border border-line p-3 font-semibold" onClick={() => { for (const k of Object.keys(localStorage)) if (k.startsWith('dd.preview.') || k.startsWith('dd.buyer.preview.')) localStorage.removeItem(k); location.reload(); }}>Reset preview data</button></main>;
}
