import { describe, expect, it } from 'vitest';
import { googleCalendarUrl, icsFile } from './calendar';

const e = { title: 'Saturday sourdough, queue opens', start: '2026-12-14T01:45:00Z', end: '2026-12-14T02:00:00Z', url: 'https://x.test/d/t/d/', details: 'Limit 2; each' };

describe('calendar', () => {
  it('writes a valid single-event .ics with a reminder', () => {
    const ics = icsFile(e, new Date('2026-12-01T00:00:00Z'));
    expect(ics).toContain('DTSTART:20261214T014500Z');
    expect(ics).toContain('DTEND:20261214T020000Z');
    expect(ics).toContain('SUMMARY:Saturday sourdough\\, queue opens');
    expect(ics).toContain('DESCRIPTION:Limit 2\\; each');
    expect(ics).toContain('TRIGGER:-PT10M');
    expect(ics.split('\r\n').at(-2)).toBe('END:VCALENDAR');
  });
  it('builds a Google Calendar link with UTC dates', () => {
    expect(googleCalendarUrl(e)).toContain('dates=20261214T014500Z%2F20261214T020000Z');
  });
});
