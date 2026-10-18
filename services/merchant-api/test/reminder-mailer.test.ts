import { describe, expect, it, vi } from 'vitest';
const { send, options } = vi.hoisted(() => ({ send: vi.fn(), options: vi.fn() }));
vi.mock('@aws-sdk/client-sesv2', () => ({ SESv2Client: class { constructor(config: unknown) { options(config); } send = send; }, SendEmailCommand: class { constructor(public input: unknown) {} } }));
const { sendReminder } = await import('../src/reminder-mailer.js');
describe('reminder mail delivery', () => {
  it('sends one private recipient using the fixed sender without OTP instrumentation or automatic retries', async () => {
    process.env.MAIL_FROM = 'codes@example.com'; send.mockResolvedValueOnce({ MessageId: 'ses-id' });
    expect(await sendReminder(' buyer@example.com ', { subject: 'Your order', text: 'Payment due' })).toBe('ses-id');
    expect(send.mock.calls[0]![0].input).toMatchObject({ FromEmailAddress: 'codes@example.com', Destination: { ToAddresses: ['buyer@example.com'] } });
    expect(send.mock.calls[0]![0].input).not.toHaveProperty('ConfigurationSetName');
    expect(options).toHaveBeenCalledWith(expect.objectContaining({ maxAttempts: 1 }));
    send.mockRejectedValueOnce(new Error('timeout'));
    await expect(sendReminder('buyer@example.com', { subject: 'Order', text: 'Payment' })).rejects.toThrow('timeout');
    expect(send).toHaveBeenCalledTimes(2);
  });
});
