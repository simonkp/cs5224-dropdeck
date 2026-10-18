import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';

// No automatic SDK retries: a timeout can mean SES accepted the email without returning a response.
const ses = new SESv2Client({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000, throwOnRequestTimeout: true } });
export async function sendReminder(to: string, content: { subject: string; text: string }): Promise<string> {
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: process.env.MAIL_FROM,
    Destination: { ToAddresses: [to.trim()] },
    // Keep reminders out of the checkout OTP configuration set and its OTP-specific metrics.
    Content: { Simple: { Subject: { Data: content.subject, Charset: 'UTF-8' }, Body: { Text: { Data: content.text, Charset: 'UTF-8' } } } },
  }), { abortSignal: AbortSignal.timeout(2500) });
  if (!response.MessageId) throw new Error('SES response had no message ID');
  return response.MessageId;
}
