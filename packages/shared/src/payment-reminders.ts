import type { Drop, MerchantProfile, Order } from './types.js';
import { trackingOf } from './merchant-analytics';

export const REMINDER_BATCH_LIMIT = 10;
export const REMINDER_COOLDOWN_MS = 24 * 3600_000;
export type ReminderStatus = 'sending' | 'accepted' | 'failed' | 'uncertain';
export interface PaymentReminder {
  status: ReminderStatus;
  attemptedAt: string;
  nextAllowedAt: number;
}
export type ReminderOrder = Order & { paymentReminder?: PaymentReminder };
export interface ReminderResult { ref: string; status: ReminderStatus | 'skipped'; message: string }

/** Both the browser and the server use this; the server always reads the current order again. */
export function reminderProblem(order: ReminderOrder, drop: Pick<Drop, 'state'>, now = Date.now()): string | undefined {
  if (!['Live', 'Closed'].includes(drop.state)) return 'This drop is not accepting payment reminders.';
  const tracking = trackingOf(order);
  if (tracking.paymentStatus !== 'awaiting') return 'Only orders marked awaiting payment can receive reminders.';
  if (tracking.attendanceStatus === 'no_show') return 'No-show orders cannot receive payment reminders.';
  if (!Number.isSafeInteger(order.amountCents) || order.amountCents <= 0) return 'This order has no payable amount.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(order.email.trim())) return 'This order has no valid email address.';
  if (order.paymentReminder && order.paymentReminder.nextAllowedAt > now) return 'A reminder was recently attempted. Check its result before sending again.';
}

/** Plain-text transactional template: never includes other buyers, merchant notes or carrier references. */
export function paymentReminderTemplate(profile: Pick<MerchantProfile, 'name' | 'paynow'>, drop: Pick<Drop, 'title'>, order: Order) {
  const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  return {
    subject: `Payment reminder · ${oneLine(profile.name)} · ${oneLine(order.ref)}`,
    text: `Hi ${oneLine(order.name)},\n\nA friendly reminder from ${oneLine(profile.name)} about your order.\n\nOrder: ${oneLine(order.ref)}\nDrop: ${oneLine(drop.title)}\nItems: ${order.qty} × ${oneLine(order.variantName)}\nAmount due: SGD ${(order.amountCents / 100).toFixed(2)}\n\nPayNow: ${oneLine(profile.paynow ?? '')}\nPlease include your order reference ${oneLine(order.ref)} with your payment.\n\nIf you have already paid, please disregard this reminder and contact the shop to reconcile your payment. Payment status is recorded manually by the shop.\n\nThank you,\n${oneLine(profile.name)}\nSent via DropDeck on behalf of the shop.`,
  };
}
