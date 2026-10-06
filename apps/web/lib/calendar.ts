/** "Add to calendar" for a drop: an .ics file (Apple, Outlook) or a Google Calendar link. */

export interface CalendarEvent {
  title: string;
  start: string; // ISO
  end: string; // ISO
  url: string;
  details?: string;
}

const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const escapeIcs = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);

export function icsFile(e: CalendarEvent, now = new Date()): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DropDeck//Drops//EN', 'BEGIN:VEVENT',
    `UID:${stamp(e.start)}-${encodeURIComponent(e.url)}@dropdeck`,
    `DTSTAMP:${stamp(now.toISOString())}`,
    `DTSTART:${stamp(e.start)}`, `DTEND:${stamp(e.end)}`,
    `SUMMARY:${escapeIcs(e.title)}`,
    `DESCRIPTION:${escapeIcs([e.details, e.url].filter(Boolean).join('\n'))}`,
    `URL:${e.url}`,
    'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', `DESCRIPTION:${escapeIcs(e.title)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

export function googleCalendarUrl(e: CalendarEvent): string {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: e.title, dates: `${stamp(e.start)}/${stamp(e.end)}`, details: [e.details, e.url].filter(Boolean).join('\n') });
  return `https://calendar.google.com/calendar/render?${q}`;
}

export function downloadIcs(e: CalendarEvent, filename: string): void {
  const url = URL.createObjectURL(new Blob([icsFile(e)], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
