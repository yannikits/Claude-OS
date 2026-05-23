import { describe, expect, it } from 'vitest';
import { CronParseError, nextFire, parseCron } from '../../../src/domains/scheduler/index.js';

describe('parseCron — Field-Erkennung', () => {
  it('erkennt 5 Felder', () => {
    const p = parseCron('0 8 * * *');
    expect(p.minute).toEqual(new Set([0]));
    expect(p.hour).toEqual(new Set([8]));
    expect(p.dayOfMonth.size).toBe(31);
    expect(p.month.size).toBe(12);
    expect(p.dayOfWeek.size).toBe(7);
  });

  it('verarbeitet Ranges', () => {
    const p = parseCron('0 9-17 * * *');
    expect(p.hour).toEqual(new Set([9, 10, 11, 12, 13, 14, 15, 16, 17]));
  });

  it('verarbeitet Schritte', () => {
    const p = parseCron('*/15 * * * *');
    expect(p.minute).toEqual(new Set([0, 15, 30, 45]));
  });

  it('verarbeitet Listen', () => {
    const p = parseCron('0,15,30,45 * * * *');
    expect(p.minute).toEqual(new Set([0, 15, 30, 45]));
  });

  it('normalisiert Sunday=7 zu 0', () => {
    const p = parseCron('0 0 * * 7');
    expect(p.dayOfWeek).toEqual(new Set([0]));
  });

  it('akzeptiert kombinierte Range mit Schritt', () => {
    const p = parseCron('0 0 1-30/5 * *');
    expect(p.dayOfMonth).toEqual(new Set([1, 6, 11, 16, 21, 26]));
  });
});

describe('parseCron — Fehlerpfade', () => {
  it('wirft bei zu wenigen Feldern', () => {
    expect(() => parseCron('0 8 *')).toThrow(CronParseError);
  });

  it('wirft bei zu vielen Feldern', () => {
    expect(() => parseCron('0 8 * * * *')).toThrow(/erwartet 5/);
  });

  it('wirft bei nicht-numerischem Token', () => {
    expect(() => parseCron('zero 8 * * *')).toThrow(CronParseError);
  });

  it('wirft bei Wert außerhalb des Field-Range', () => {
    expect(() => parseCron('60 0 * * *')).toThrow(/außerhalb \[0-59\]/);
  });

  it('wirft bei Range mit end < start', () => {
    expect(() => parseCron('0 17-9 * * *')).toThrow(/end < start/);
  });

  it('wirft bei Schritt 0', () => {
    expect(() => parseCron('*/0 * * * *')).toThrow(/positiv/);
  });
});

describe('nextFire — Berechnungen', () => {
  it('findet nächsten täglichen 08:00-Slot', () => {
    const parsed = parseCron('0 8 * * *');
    const from = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-20T08:00:00.000Z');
  });

  it('wraps zum nächsten Tag wenn current time bereits nach Slot', () => {
    const parsed = parseCron('0 8 * * *');
    const from = new Date(Date.UTC(2026, 4, 20, 9, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-21T08:00:00.000Z');
  });

  it('findet ersten Mo/Di/Mi-08:00-Slot (weekday-only)', () => {
    const parsed = parseCron('0 8 * * 1-3');
    // 2026-05-20 ist Mi (3) 07:00 UTC, also gleicher Tag um 08:00.
    const from = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-20T08:00:00.000Z');
  });

  it('gibt null bei unerfüllbarer Expression zurück', () => {
    // 31. Februar existiert nie
    const parsed = parseCron('0 0 31 2 *');
    const from = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const next = nextFire(parsed, from);
    expect(next).toBeNull();
  });

  it('respektiert POSIX-Cron-OR-Konvention bei day+weekday', () => {
    // "Jeden 1. ODER Mo" — 2026-05-04 (Mo) sollte matchen
    const parsed = parseCron('0 0 1 * 1');
    const from = new Date(Date.UTC(2026, 4, 3, 0, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('startet streng NACH from (mind. 1 Minute Abstand)', () => {
    const parsed = parseCron('* * * * *');
    const from = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-20T07:01:00.000Z');
  });
});

describe('n5: wildcard-flag vs aufgezaehlte Liste', () => {
  it('Wildcard `*` setzt wildcardDayOfMonth/Week true', () => {
    const p = parseCron('0 0 * * *');
    expect(p.wildcardDayOfMonth).toBe(true);
    expect(p.wildcardDayOfWeek).toBe(true);
  });

  it('Step-Wildcard `*/N` zaehlt auch als Wildcard', () => {
    const p = parseCron('0 0 */2 * */3');
    expect(p.wildcardDayOfMonth).toBe(true);
    expect(p.wildcardDayOfWeek).toBe(true);
  });

  it('Explizite Range `1-31` ist KEIN Wildcard, auch wenn dieselben Werte expandiert werden', () => {
    const p = parseCron('0 0 1-31 * 0-6');
    expect(p.dayOfMonth.size).toBe(31);
    expect(p.dayOfWeek.size).toBe(7);
    expect(p.wildcardDayOfMonth).toBe(false);
    expect(p.wildcardDayOfWeek).toBe(false);
  });

  it('Restriktive Range (z. B. nur weekday 1-5) wird korrekt erkannt', () => {
    const p = parseCron('0 8 * * 1-5');
    expect(p.wildcardDayOfMonth).toBe(true);
    expect(p.wildcardDayOfWeek).toBe(false);
  });

  it('nextFire mit "1-31 * 0-6" (beide explizit, OR-clause) feuert nur an matching Tagen', () => {
    // "1-31" deckt jeden Tag des Monats ab UND "0-6" deckt jeden Wochentag ab.
    // Beide Felder sind restriktiv → POSIX OR-Logik → match falls dayMatch
    // OR weekdayMatch. Da beide Sets alle moeglichen Werte enthalten, ist
    // jeder Slot Match — verhalten faktisch wie `* * *`.
    const parsed = parseCron('0 8 1-31 * 0-6');
    const from = new Date(Date.UTC(2026, 4, 20, 7, 0, 0));
    const next = nextFire(parsed, from);
    expect(next?.toISOString()).toBe('2026-05-20T08:00:00.000Z');
  });

  it('Single-Value `15` ist nicht-Wildcard (regression: dayOfMonth.size === 1)', () => {
    const p = parseCron('0 0 15 * *');
    expect(p.wildcardDayOfMonth).toBe(false);
    expect(p.dayOfMonth).toEqual(new Set([15]));
  });
});
