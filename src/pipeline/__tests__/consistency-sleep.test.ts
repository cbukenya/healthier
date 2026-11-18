import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays } from '../../lib/date';
import { t } from '../../i18n';
import { readiness, sleepRegularity } from '../derive';
import { emptyRecord } from '../normalize';
import { evaluate } from '../insights/engine';
import { weekSummary } from '../insights';

type Day = ReturnType<typeof emptyRecord>;

/** Days from `start`, each with a night filed under it (the morning it ended), a resting heart rate and steps. */
function nights(start: string, n: number, night: (i: number, date: string) => { bed?: number; wake?: number; asleep?: number } = () => ({})) {
  return Array.from({ length: n }, (_, i) => {
    const d = emptyRecord(addDays(start, i));
    const { bed = 1380, wake = 420, asleep = 450 } = night(i, d.date);
    d.steps = 9000;
    d.restingHr = 60 + (i % 3) - 1;
    d.hrv = 40 + ((i % 5) - 2);
    d.sleep = {
      date: d.date, isMainSleep: true, isNap: false,
      bedtimeMin: bed, wakeMin: wake, bedtimeIso: '', wakeIso: '',
      minutesAsleep: asleep, onsetLatencyMin: null, minutesAwake: 10, minutesInBed: asleep + 10,
      efficiency: 97, stages: null, segments: [], shortAwakeningsMin: [],
    };
    return d;
  });
}

const found = (days: Day[], now: Date, id: string) => evaluate({ days } as any, now)?.found.find((f) => f.id === id);

describe('figures that agree across pages — sleep', () => {
  it("reviews last week's nights, the ones filed Tuesday to this morning, as This week shows them", () => {
    // 35 days ending Monday 27 July. Last week is Monday 20 to Sunday 26 July; its nights end on the
    // mornings of 21 to 27 July. The night that ended on Monday 20 July belongs to the week before.
    const days = nights('2026-06-23', 35, (_, date) => ({
      asleep: date === '2026-07-20' ? 600 : date >= '2026-07-21' ? 420 : 450,
    }));
    for (const d of days) {
      if (d.date >= '2026-07-21') d.hrv = 44; // last week's nights, 10% above the usual 40
      if (d.date === '2026-07-20') d.hrv = 20; // the week before's last night
    }
    days[days.length - 1].steps = 300; // today is still counting
    const card = found(days, new Date('2026-07-27T08:00:00'), 'weekly-review')!;
    assert.equal(card.text,
      'Last week you averaged 9,000 steps a day, about the same as the week before. You slept 7h 00m a night on average. Your HRV was above usual.');
    // The same nights as This week on a Monday morning.
    assert.equal(weekSummary(days)!.sleep!.avgMin, 420);
  });

  it('reads regularity at the start of a month over the last 30 nights, last night included, as the Sleep page does', () => {
    // 62 days ending 1 September. The 30 nights before the last 30 swing between two bedtimes;
    // the last 30 are steady, but last night ran late, so leaving it out would read too high.
    const days = nights('2026-07-02', 62, (i, date) =>
      date === '2026-09-01' ? { bed: 180, wake: 660 }
        : i < 32 ? (i % 2 ? { bed: 1380, wake: 420 } : { bed: 120, wake: 600 })
          : { bed: 1380, wake: 420 });
    const now = new Date('2026-09-01T08:00:00');
    const chart = sleepRegularity(days.slice(-30))!.score; // the Sleep page's default 30-day span
    const before = sleepRegularity(days.slice(-60, -30))!.score;
    assert.notEqual(sleepRegularity(days.slice(-31, -1))!.score, chart, 'the test tells the two windows apart');

    const ledger = found(days, now, 'monthly-ledger')!;
    assert.match(ledger.text, new RegExp(`your sleep regularity score went from ${before} to ${chart}\\.$`));
    const climbing = found(days, now, 'sri-climbing')!;
    assert.match(climbing.text, new RegExp(`rose from ${before} to ${chart} this month`));
  });

  it("keeps steps in the monthly summary to finished days while regularity takes last night", () => {
    const days = nights('2026-07-02', 62);
    days[days.length - 1].steps = 0; // this morning, before a step is taken
    const ledger = found(days, new Date('2026-09-01T08:00:00'), 'monthly-ledger')!;
    assert.match(ledger.text, /^Compared with the 30 days before, you walked about the same,/);
  });

  it('names the sleep debt by the nights it counts, never as this week', () => {
    // A week of short nights, then last night: the debt is the 7 nights before last night.
    const days = nights('2026-07-01', 28, (i) => ({ asleep: i >= 20 ? 330 : 450 }));
    const r = readiness(days);
    const debt = r.parts.find((p) => p.id === 'sleepDebt')!;
    assert.match(debt.detail, /across the prior 7 nights$/);
    assert.equal(t('insights.today.reasons.sleepDebt.because', { balance: 'short', hours: '8.0 hours', nights: 7 }),
      "you're 8.0 hours short on sleep over the prior 7 nights");
    assert.equal(t('insights.today.reasons.sleepDebt.statement', { balance: 'extra', nights: 7 }),
      "you've had a little extra sleep over the prior 7 nights");
    const card = found(days, new Date('2026-07-28T08:00:00'), 'sleep-debt')!;
    assert.equal(card.title, "You're very short on sleep");
    assert.match(card.text, /^Over the 7 nights before last night, you slept [\d.]+ hours less than you need\./);
  });
});
