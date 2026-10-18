import { expect, it } from 'vitest';
import { analyticsFromForTab, type AnalyticsTab } from './analytics-navigation';

it('keeps Growth ranges available in Advanced but normalizes every basic destination to 31 inclusive days', () => {
  expect(analyticsFromForTab('2026-08-01','2026-10-18','advanced')).toBe('2026-08-01');
  for (const tab of ['overview','inventory','payments','fulfillment'] as AnalyticsTab[]) {
    expect(analyticsFromForTab('2026-08-01','2026-10-18',tab)).toBe('2026-09-18');
    expect(analyticsFromForTab('2026-09-18','2026-10-18',tab)).toBe('2026-09-18');
    expect(analyticsFromForTab('2026-10-12','2026-10-18',tab)).toBe('2026-10-12');
  }
});

it('uses calendar-day boundaries across months and leaves invalid input for normal validation', () => {
  expect(analyticsFromForTab('2026-01-01','2026-03-01','payments')).toBe('2026-01-30');
  expect(analyticsFromForTab('','2026-10-18','payments')).toBe('');
  expect(analyticsFromForTab('2026-10-12','','overview')).toBe('2026-10-12');
});
