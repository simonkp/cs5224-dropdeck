import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { ssmSecret } from '@dropdeck/shared/secrets';
import { healthEvent } from '@dropdeck/shared/observability';

/**
 * One interface, several senders (decision 0002). MAIL_MODE:
 *   ses  Amazon SES from MAIL_FROM; Resend as fallback when RESEND_KEY_PARAM is set.
 *   log  no email: the code is logged and returned to the page. For dev and test stages only; the stack refuses
 *        it on prod. It is the default until a domain is verified in SES.
 */
export interface Mail {
  tenantId?: string;
  dropId?: string;
  to: string;
  subject: string;
  text: string;
}

export const mailMode = () => (process.env.MAIL_MODE === 'ses' ? 'ses' : 'log');

let ses: SESv2Client | undefined;
const resendKey = ssmSecret('RESEND_KEY_PARAM');

async function viaSes(m: Mail): Promise<void> {
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error('MAIL_FROM is not set');
  ses ??= new SESv2Client({});
  const result = await ses.send(new SendEmailCommand({
    FromEmailAddress: from,
    ...(process.env.SES_CONFIG_SET ? { ConfigurationSetName: process.env.SES_CONFIG_SET,
      EmailTags: m.tenantId && m.dropId ? [{ Name:'dd-tenant',Value:m.tenantId },{ Name:'dd-drop',Value:m.dropId }] : undefined } : {}),
    Destination: { ToAddresses: [m.to] },
    Content: { Simple: { Subject: { Data: m.subject }, Body: { Text: { Data: m.text } } } },
  }));
  if(m.tenantId && m.dropId) healthEvent('otpAccepted',m.tenantId,m.dropId,{mailMode:'ses',messageId:result.MessageId});
}

async function viaResend(m: Mail): Promise<void> {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${await resendKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM, to: [m.to], subject: m.subject, text: m.text }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}`);
}

export async function sendMail(m: Mail): Promise<void> {
  if (mailMode() === 'log') {
    if(m.tenantId && m.dropId) healthEvent('otpTestMode',m.tenantId,m.dropId,{mailMode:'log'});
    // Masked: in a study on a log-mode stage, participants' addresses should not sit in CloudWatch.
    console.log(JSON.stringify({ level: 'info', msg: 'mail (log mode, not sent)', to: m.to.replace(/^(.)[^@]*(.@)/, '$1•••$2') }));
    return;
  }
  try {
    await viaSes(m);
  } catch (e) {
    if(m.tenantId && m.dropId) healthEvent('otpFailed',m.tenantId,m.dropId,{mailMode:'ses'});
    if (!process.env.RESEND_KEY_PARAM) throw e;
    console.error(JSON.stringify({ level: 'error', msg: 'SES send failed; trying Resend', err: String(e) }));
    await viaResend(m);
    if(m.tenantId && m.dropId) healthEvent('otpFallback',m.tenantId,m.dropId,{mailMode:'ses'});
  }
}
