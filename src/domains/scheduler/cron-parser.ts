/**
 * Minimaler 5-Field-Cron-Parser für den `schedule`-Subcommand.
 *
 * Unterstützt: `min(0-59) hour(0-23) day(1-31) month(1-12) weekday(0-7)`
 *
 * Pro Field zulässige Token:
 *  - `*`            — jeder Wert
 *  - `N`            — exakter Wert
 *  - `N-M`          — Range (inklusiv, M >= N)
 *  - `* /K`         — Schritt-Werte ab 0 mit Inkrement K
 *  - `N-M/K`        — Range mit Schritt
 *  - `A,B,C`        — Liste der obigen Token kommagetrennt
 *
 * Bewusst NICHT unterstützt (Out-of-Scope für v1.5):
 *  - `@yearly`, `@monthly`, `@reboot` (Alias-Strings)
 *  - `L` (last-day-of-month), `W` (nearest-weekday), `#` (n-th-weekday)
 *  - 6/7-Field-Variants mit Sekunden oder Jahr
 *  - Timezone (alles wird in UTC interpretiert wenn `tz: 'UTC'`, sonst
 *    local time)
 *
 * Sunday darf sowohl als 0 als auch als 7 angegeben werden (POSIX-cron-
 * Konvention).
 *
 * @module @domains/scheduler/cron-parser
 */

import { CronParseError } from './types.js';

interface FieldRange {
  readonly min: number;
  readonly max: number;
  /** Wenn `true`, wird `max+1` ebenfalls toleriert und auf `min` normalisiert
   *  (z. B. Sunday=7 → 0 im weekday-Field). */
  readonly aliasOver?: { from: number; to: number };
}

const FIELDS: ReadonlyArray<FieldRange> = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day
  { min: 1, max: 12 }, // month
  { min: 0, max: 6, aliasOver: { from: 7, to: 0 } }, // weekday
];

const FIELD_NAMES = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'] as const;

/** Pro Field: Set zulässiger Werte. */
export interface ParsedCron {
  readonly raw: string;
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  /**
   * n5 (2026-05-23 todo-audit): explizite Wildcard-Markierung pro Field
   * statt der frueheren `.size === <max>`-Heuristik. Letztere konnte
   * eine voll-aufgezaehlte Liste (z. B. `1-31`) faelschlich als
   * Wildcard interpretieren, was die `matchesDayClause`-OR/AND-Logik
   * korrumpierte. Wir markieren ein Field als Wildcard nur wenn das
   * urspruengliche Token `*` ODER `* / N` (step-wildcard, ohne Spaces
   * im echten Token) war.
   */
  readonly wildcardDayOfMonth: boolean;
  readonly wildcardDayOfWeek: boolean;
}

function parseInteger(token: string, context: string): number {
  if (!/^-?\d+$/.test(token)) {
    throw new CronParseError(`${context}: "${token}" ist kein Integer`);
  }
  const n = Number.parseInt(token, 10);
  if (!Number.isFinite(n))
    throw new CronParseError(`${context}: "${token}" ist kein Finite-Integer`);
  return n;
}

function expandStep(
  start: number,
  end: number,
  step: number,
  range: FieldRange,
  context: string,
): number[] {
  if (step <= 0) throw new CronParseError(`${context}: Schritt "${step}" muss positiv sein`);
  if (start < range.min || start > range.max) {
    throw new CronParseError(`${context}: Wert ${start} außerhalb [${range.min}-${range.max}]`);
  }
  if (end < range.min || end > range.max) {
    throw new CronParseError(`${context}: Wert ${end} außerhalb [${range.min}-${range.max}]`);
  }
  if (end < start) {
    throw new CronParseError(`${context}: Range ${start}-${end} hat end < start`);
  }
  const out: number[] = [];
  for (let v = start; v <= end; v += step) out.push(v);
  return out;
}

function normaliseValue(v: number, range: FieldRange, context: string): number {
  if (range.aliasOver && v === range.aliasOver.from) return range.aliasOver.to;
  if (v < range.min || v > range.max) {
    throw new CronParseError(`${context}: Wert ${v} außerhalb [${range.min}-${range.max}]`);
  }
  return v;
}

function parseFieldToken(token: string, range: FieldRange, context: string): number[] {
  // Schritt-Form: "BASE/STEP"
  let base = token;
  let step = 1;
  if (token.includes('/')) {
    const [b, s, ...rest] = token.split('/');
    if (rest.length > 0 || b === undefined || s === undefined) {
      throw new CronParseError(`${context}: ungültiger Schritt-Ausdruck "${token}"`);
    }
    base = b;
    step = parseInteger(s, `${context} (Schritt)`);
  }
  if (base === '*') {
    return expandStep(range.min, range.max, step, range, context);
  }
  if (base.includes('-')) {
    const parts = base.split('-');
    if (parts.length !== 2) {
      throw new CronParseError(`${context}: ungültige Range "${base}"`);
    }
    const start = normaliseValue(parseInteger(parts[0] ?? '', context), range, context);
    const end = normaliseValue(parseInteger(parts[1] ?? '', context), range, context);
    return expandStep(start, end, step, range, context);
  }
  // Einzelwert
  if (step !== 1) {
    throw new CronParseError(`${context}: Schritt ohne Range oder * nicht erlaubt ("${token}")`);
  }
  const single = normaliseValue(parseInteger(base, context), range, context);
  return [single];
}

function parseField(raw: string, range: FieldRange, fieldName: string): Set<number> {
  const context = `cron-field ${fieldName}`;
  const out = new Set<number>();
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (trimmed === '') throw new CronParseError(`${context}: leerer Token in "${raw}"`);
    for (const v of parseFieldToken(trimmed, range, context)) out.add(v);
  }
  if (out.size === 0) throw new CronParseError(`${context}: keine Werte aus "${raw}"`);
  return out;
}

/**
 * n5 (2026-05-23 todo-audit): true wenn JEDES kommagetrennte Token in
 * `raw` ein literales `*` ist (mit optionalem step-suffix). Eine
 * voll-aufgezaehlte Liste wie `1-31` oder `0,1,2,...,30` ist explizit
 * KEIN Wildcard — sie expandiert nur zufaellig auf dieselbe Anzahl
 * Werte, soll aber von der dayClause-Logik als restriktiv behandelt
 * werden.
 */
function fieldIsWildcard(raw: string): boolean {
  const tokens = raw.split(',').map((t) => t.trim());
  if (tokens.length === 0) return false;
  return tokens.every((t) => t === '*' || /^\*\/\d+$/.test(t));
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `Cron-Expression "${expression}" hat ${fields.length} Felder, erwartet 5 (min hour day month weekday)`,
    );
  }
  const [minRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    raw: expression.trim(),
    minute: parseField(minRaw, FIELDS[0] as FieldRange, FIELD_NAMES[0]),
    hour: parseField(hourRaw, FIELDS[1] as FieldRange, FIELD_NAMES[1]),
    dayOfMonth: parseField(dayRaw, FIELDS[2] as FieldRange, FIELD_NAMES[2]),
    month: parseField(monthRaw, FIELDS[3] as FieldRange, FIELD_NAMES[3]),
    dayOfWeek: parseField(weekdayRaw, FIELDS[4] as FieldRange, FIELD_NAMES[4]),
    wildcardDayOfMonth: fieldIsWildcard(dayRaw),
    wildcardDayOfWeek: fieldIsWildcard(weekdayRaw),
  };
}

/**
 * Berechnet den nächsten Feuer-Zeitpunkt strikt nach `from`. Iteriert
 * minutenweise vorwärts; cap bei 5 Jahren (deterministischer Abbruch
 * falls die Expression nicht erfüllbar ist, z. B. "0 0 31 2 *").
 *
 * `tz` steuert ob lokal oder UTC interpretiert wird; Default 'UTC'
 * vermeidet DST-Falle.
 *
 * M26 (2026-05-21 code-review): bei `tz: 'local'` und DST-Sprung
 * (spring-forward) wird die uebersprungene Stunde NICHT gefeuert —
 * `cursor.setTime(+60_000)` ueberspringt direkt 2:00 → 3:00 in
 * Zeitzonen mit Sommerzeit-Umstellung. Akzeptierte Limitation fuer
 * v1: ein einzeln-betroffener Fire pro Jahr (Spring-Forward) bzw. ein
 * doppelt-feuernder Fire (Fall-Back) sind in einem 60s-Tick-Loop
 * vertretbar; User die exakte DST-stabile Schedules brauchen sollen
 * `tz: 'UTC'` setzen.
 */
export function nextFire(
  parsed: ParsedCron,
  from: Date = new Date(),
  tz: 'UTC' | 'local' = 'UTC',
): Date | null {
  const MAX_MINUTES = 5 * 365 * 24 * 60; // 5 Jahre cap
  const cursor = new Date(from.getTime() + 60_000); // mindestens eine Minute später
  cursor.setSeconds(0, 0);
  for (let i = 0; i < MAX_MINUTES; i++) {
    const minute = tz === 'UTC' ? cursor.getUTCMinutes() : cursor.getMinutes();
    const hour = tz === 'UTC' ? cursor.getUTCHours() : cursor.getHours();
    const day = tz === 'UTC' ? cursor.getUTCDate() : cursor.getDate();
    const month0 = tz === 'UTC' ? cursor.getUTCMonth() : cursor.getMonth(); // 0..11
    const weekday = tz === 'UTC' ? cursor.getUTCDay() : cursor.getDay(); // 0..6
    if (
      parsed.minute.has(minute) &&
      parsed.hour.has(hour) &&
      parsed.month.has(month0 + 1) &&
      // POSIX-Cron-Konvention: wenn day-of-month UND day-of-week beide
      // restriktiv sind (kein `*`), zählt das ODER — Treffer in einem
      // der beiden Felder reicht.
      matchesDayClause(parsed, day, weekday)
    ) {
      return new Date(cursor);
    }
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

function matchesDayClause(parsed: ParsedCron, day: number, weekday: number): boolean {
  // n5 (2026-05-23 todo-audit): "restrictive" = wenn das urspruengliche
  // Token KEIN Wildcard war. Vorher haben wir `.size !== max` als Proxy
  // benutzt, was eine voll-aufgezaehlte Liste (z. B. `1-31`) faelschlich
  // als Wildcard interpretiert haette. Jetzt nutzen wir den expliziten
  // `wildcard*`-Flag aus dem Parser.
  const dayIsRestrictive = !parsed.wildcardDayOfMonth;
  const weekdayIsRestrictive = !parsed.wildcardDayOfWeek;
  const dayMatch = parsed.dayOfMonth.has(day);
  const weekdayMatch = parsed.dayOfWeek.has(weekday);
  if (dayIsRestrictive && weekdayIsRestrictive) return dayMatch || weekdayMatch;
  if (dayIsRestrictive) return dayMatch;
  if (weekdayIsRestrictive) return weekdayMatch;
  return true;
}
