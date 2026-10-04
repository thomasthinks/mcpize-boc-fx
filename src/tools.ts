/**
 * Pure tool functions — business logic only, no MCP dependency.
 * Each function is registered as an MCP tool in index.ts.
 *
 * All functions throw FxError on failure; index.ts converts these into
 * isError:true JSON-RPC tool responses. BoC rate direction semantics are
 * documented in src/lib/valet.ts.
 */

import {
  SOURCE_LABEL,
  alignedObservation,
  crossRate,
  fetchSeries,
  getLatestRates,
  round6,
  supportedCodes,
} from "./lib/valet.js";

export class FxError extends Error {
  suggestion: string;
  constructor(message: string, suggestion: string) {
    super(message);
    this.name = "FxError";
    this.suggestion = suggestion;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertValidDate(value: string, fieldName: string): void {
  if (!DATE_RE.test(value)) {
    throw new FxError(
      `Invalid ${fieldName} "${value}". Expected YYYY-MM-DD.`,
      "Use a date in YYYY-MM-DD format, e.g. 2026-10-01."
    );
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new FxError(
      `Invalid ${fieldName} "${value}". Not a real calendar date.`,
      "Use a real calendar date in YYYY-MM-DD format."
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  if (value > today) {
    throw new FxError(
      `The date ${value} is in the future. Bank of Canada rates are published daily around 16:30 ET.`,
      "Omit the date to use the most recent published rate, or use today or an earlier date."
    );
  }
  if (value < "2017-01-01") {
    throw new FxError(
      `No Bank of Canada daily FX data before 2017 (requested ${value}).`,
      "Use a date on or after 2017-01-01."
    );
  }
}

async function assertSupportedCode(code: string): Promise<void> {
  const codes = await supportedCodes();
  if (!codes.includes(code)) {
    const examples = codes.filter((c) => c !== "CAD").slice(0, 6).join(", ");
    throw new FxError(
      `Unsupported currency code "${code}". Bank of Canada publishes daily rates for: ${codes.join(", ")}.`,
      `Use a 3-letter code like CAD, ${examples}, or omit. BoC covers ~27 currencies against CAD.`
    );
  }
}

// ============================================================================
// convert_currency
// ============================================================================

export interface ConvertCurrencyResult {
  [key: string]: unknown;
  amount: number;
  from: string;
  to: string;
  rate: number;
  converted_amount: number;
  rate_date: string;
  requested_date: string | null;
  source: string;
  note?: string;
}

export async function convertCurrency(
  amount: number,
  from: string,
  to: string,
  date?: string
): Promise<ConvertCurrencyResult> {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new FxError(
      `Invalid amount "${amount}". Amount must be a positive number.`,
      "Pass a positive number for the amount to convert, e.g. 100."
    );
  }
  const fromCode = from.toUpperCase();
  const toCode = to.toUpperCase();
  if (date !== undefined) assertValidDate(date, "date");
  await assertSupportedCode(fromCode);
  await assertSupportedCode(toCode);

  // Same-currency: no upstream call needed.
  if (fromCode === toCode) {
    const rateDate = date ?? new Date().toISOString().slice(0, 10);
    return {
      amount,
      from: fromCode,
      to: toCode,
      rate: 1,
      converted_amount: round6(amount),
      rate_date: rateDate,
      requested_date: date ?? null,
      source: SOURCE_LABEL,
    };
  }

  const needed = [fromCode, toCode].filter((c) => c !== "CAD");
  const { date: rateDate, values } = await alignedObservation(needed, date);
  const rate = round6(crossRate(values, fromCode, toCode));
  const result: ConvertCurrencyResult = {
    amount,
    from: fromCode,
    to: toCode,
    rate,
    converted_amount: round6(amount * rate),
    rate_date: rateDate,
    requested_date: date ?? null,
    source: SOURCE_LABEL,
  };
  if (date && rateDate !== date) {
    result.note =
      `No Bank of Canada rate published on ${date} (weekends and holidays have no observations). ` +
      `Used the most recent available rate, from ${rateDate}.`;
  }
  // Stale series warning: RUB/SAR/VND publish infrequently or are discontinued.
  const today = new Date().toISOString().slice(0, 10);
  const daysOld =
    (new Date(`${today}T00:00:00Z`).getTime() - new Date(`${rateDate}T00:00:00Z`).getTime()) /
      86_400_000;
  if (daysOld > 30) {
    result.note =
      (result.note ? result.note + " " : "") +
      `Warning: the most recent Bank of Canada rate for ${needed.join("/")} is from ${rateDate} ` +
      `(${Math.round(daysOld)} days old) — this series is published infrequently or discontinued. ` +
      `Treat the result as indicative only.`;
  }
  return result;
}

// ============================================================================
// fx_history
// ============================================================================

export interface FxHistoryPoint {
  [key: string]: unknown;
  date: string;
  rate: number;
}

export interface FxHistoryResult {
  [key: string]: unknown;
  from: string;
  to: string;
  series: FxHistoryPoint[];
  count: number;
  source: string;
}

const MAX_HISTORY_DAYS = 5 * 366;

export async function fxHistory(
  from: string,
  to: string,
  startDate: string,
  endDate: string
): Promise<FxHistoryResult> {
  const fromCode = from.toUpperCase();
  const toCode = to.toUpperCase();
  assertValidDate(startDate, "start_date");
  assertValidDate(endDate, "end_date");
  if (endDate < startDate) {
    throw new FxError(
      `end_date (${endDate}) is before start_date (${startDate}).`,
      "Swap the dates so start_date comes first."
    );
  }
  const spanDays =
    (new Date(`${endDate}T00:00:00Z`).getTime() - new Date(`${startDate}T00:00:00Z`).getTime()) /
      86_400_000;
  if (spanDays > MAX_HISTORY_DAYS) {
    throw new FxError(
      `Date range is ${Math.round(spanDays)} days; the maximum is 5 years.`,
      "Narrow the range to 5 years or less (e.g. query year by year)."
    );
  }
  await assertSupportedCode(fromCode);
  await assertSupportedCode(toCode);

  const needed = [fromCode, toCode].filter((c) => c !== "CAD");
  const fetched = await Promise.all(
    needed.map((code) => fetchSeries(code, { startDate, endDate, order: "asc" }))
  );

  const byDate = new Map<string, Map<string, number>>();
  for (let i = 0; i < needed.length; i++) {
    for (const obs of fetched[i]) {
      if (obs.value === null) continue;
      let row = byDate.get(obs.date);
      if (!row) {
        row = new Map();
        byDate.set(obs.date, row);
      }
      row.set(needed[i], obs.value);
    }
  }

  const series: FxHistoryPoint[] = [];
  for (const date of [...byDate.keys()].sort()) {
    if (fromCode === toCode) {
      series.push({ date, rate: 1 });
      continue;
    }
    const row = byDate.get(date)!;
    if (!needed.every((c) => row.has(c))) continue; // skip days missing either leg
    const values: Record<string, number> = {};
    for (const c of needed) values[c] = row.get(c)!;
    series.push({ date, rate: round6(crossRate(values, fromCode, toCode)) });
  }

  if (series.length === 0) {
    throw new FxError(
      `No Bank of Canada rate data for ${fromCode}/${toCode} between ${startDate} and ${endDate}.`,
      "The range may fall entirely on weekends/holidays, or the series may be published infrequently or discontinued (RUB, SAR, VND). Widen the range or pick business days."
    );
  }
  return {
    from: fromCode,
    to: toCode,
    series,
    count: series.length,
    source: SOURCE_LABEL,
  };
}

// ============================================================================
// latest_rates
// ============================================================================

export interface LatestRatesResult {
  [key: string]: unknown;
  date: string;
  base: string;
  rates: Record<string, number>;
  count: number;
  cached: boolean;
  source: string;
}

export async function latestRates(): Promise<LatestRatesResult> {
  const data = await getLatestRates();
  return {
    date: data.date,
    base: data.base,
    rates: data.rates,
    count: data.count,
    cached: data.cached,
    source: data.source,
  };
}
