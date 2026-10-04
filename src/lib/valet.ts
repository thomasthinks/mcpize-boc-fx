/**
 * Bank of Canada Valet API client.
 *
 * Rate-direction semantics (verified against live data 2026-10-03):
 *   BoC daily FX series are keyed FX{CODE}CAD, e.g. FXUSDCAD, FXEURCAD, and
 *   the value is the number of CANADIAN DOLLARS per 1 unit of the foreign
 *   currency. Verified: FXEURCAD = 1.6037 (1 EUR buys ~1.60 CAD),
 *   FXUSDCAD = 1.4246, FXAUDCAD = 0.9910 (1 AUD buys ~0.99 CAD).
 *
 *   So for a series value R_X: 1 X = R_X CAD.
 *   Conversion math (rate = units of `to` per 1 unit of `from`):
 *     from == to          -> 1
 *     to == CAD           -> R_from
 *     from == CAD         -> 1 / R_to
 *     neither is CAD      -> R_from / R_to   (CAD cross-rate)
 *
 * Group: FX_RATES_DAILY (27 series as of Oct 2026).
 * Docs: https://www.bankofcanada.ca/valet/docs
 */

export interface ValetObservation {
  date: string; // YYYY-MM-DD
  /** CAD per 1 unit of the currency, or null when the BoC published no value that day */
  value: number | null;
}

interface RawValetResponse {
  observations?: Array<Record<string, unknown>>;
  seriesDetail?: Record<string, { label?: string; description?: string }>;
  message?: string;
}

const VALET_BASE = "https://www.bankofcanada.ca/valet";
export const FX_GROUP = "FX_RATES_DAILY";
export const SOURCE_LABEL = "Bank of Canada daily exchange rates";
export const FETCH_TIMEOUT_MS = 10_000;

/** Hardcoded fallback so validation works even if the series list fetch fails. */
const KNOWN_CODES_FALLBACK = [
  "AUD", "BRL", "CHF", "CNY", "EUR", "GBP", "HKD", "IDR", "INR",
  "JPY", "KRW", "MXN", "MYR", "NOK", "NZD", "PEN", "PLN", "RUB",
  "SAR", "SEK", "SGD", "THB", "TRY", "TWD", "USD", "VND", "ZAR",
];

// Series-list cache: refreshed at most once per 24h.
let codesCache: { codes: string[]; fetchedAt: number } | null = null;

export function clearCachesForTests(): void {
  codesCache = null;
  latestRatesCache = null;
}

export function seriesKeyFor(code: string): string {
  return `FX${code}CAD`;
}

async function fetchJson(url: string): Promise<RawValetResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "boc-fx-mcp/1.0.0", Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(
        `Bank of Canada Valet API rejected the request (HTTP ${res.status} ${res.statusText}). ` +
          `This is an upstream data issue, not a problem with your input.`
      );
    }
    return (await res.json()) as RawValetResponse;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        "Bank of Canada Valet API timed out after 10 seconds. Suggest: retry the call in a few seconds."
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch daily observations for one BoC FX series.
 * Pass { recent } for the N most recent observations (optionally bounded by endDate),
 * or { startDate, endDate } for a bounded range.
 */
export async function fetchSeries(
  code: string,
  opts: { recent?: number; startDate?: string; endDate?: string; order?: "asc" | "desc" }
): Promise<ValetObservation[]> {
  const key = seriesKeyFor(code);
  const url = new URL(`${VALET_BASE}/observations/${key}/json`);
  if (opts.recent !== undefined) url.searchParams.set("recent", String(opts.recent));
  if (opts.startDate) url.searchParams.set("start_date", opts.startDate);
  if (opts.endDate) url.searchParams.set("end_date", opts.endDate);
  url.searchParams.set("order_dir", opts.order ?? "desc");

  const data = await fetchJson(url.toString());
  if (data.message) {
    throw new Error(`Bank of Canada Valet API error for series ${key}: ${data.message}`);
  }
  const observations = data.observations ?? [];
  return observations.map((o) => {
    const date = typeof o["d"] === "string" ? (o["d"] as string) : "";
    const raw = o[key] as { v?: string } | undefined;
    const parsed = raw?.v !== undefined ? parseFloat(raw.v) : NaN;
    return { date, value: Number.isFinite(parsed) ? parsed : null };
  });
}

/** Codes published by the BoC in the FX_RATES_DAILY group (plus CAD). */
export async function supportedCodes(): Promise<string[]> {
  const now = Date.now();
  if (codesCache && now - codesCache.fetchedAt < 24 * 60 * 60 * 1000) {
    return codesCache.codes;
  }
  try {
    const data = await fetchJson(`${VALET_BASE}/observations/group/${FX_GROUP}/json?order_dir=desc&recent=1`);
    const detail = data.seriesDetail ?? {};
    const codes = Object.keys(detail)
      .map((k) => (k.startsWith("FX") && k.endsWith("CAD") ? k.slice(2, -3) : ""))
      .filter(Boolean)
      .sort();
    if (codes.length > 0) {
      codesCache = { codes: ["CAD", ...codes], fetchedAt: now };
      return codesCache.codes;
    }
  } catch {
    // fall through to fallback
  }
  return ["CAD", ...[...KNOWN_CODES_FALLBACK].sort()];
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Find the most recent observation on or before endDate (or the latest overall
 * when endDate is undefined) for which ALL of the given series have values.
 * BoC publishes no rates on weekends/holidays, so this naturally walks back
 * to the nearest prior business day. Never fabricates data.
 *
 * Note: a few series are stale/discontinued (RUB and SAR last published
 * 2026-04-30, VND 2019-12-31), so when an end date is given we scan a wide
 * lookback window rather than assuming the last business day has values.
 */
export async function alignedObservation(
  codes: string[],
  endDate?: string
): Promise<{ date: string; values: Record<string, number> }> {
  if (!endDate) {
    const fetched = await Promise.all(
      codes.map((code) => fetchSeries(code, { recent: 15, order: "desc" }))
    );
    return firstAligned(codes, fetched, undefined);
  }

  // Phase 1: 45-day window ending on endDate (covers weekends/holidays).
  const windowStart = shiftDate(endDate, -45);
  const fetchedWindow = await Promise.all(
    codes.map((code) =>
      fetchSeries(code, { startDate: windowStart, endDate, order: "desc" })
    )
  );
  try {
    return firstAligned(codes, fetchedWindow, endDate);
  } catch {
    // Phase 2: stale/discontinued series — scan the last 250 observations and
    // filter to dates on or before endDate.
    const fetchedDeep = await Promise.all(
      codes.map((code) => fetchSeries(code, { recent: 250, order: "desc" }))
    );
    const filtered = fetchedDeep.map((obs) => obs.filter((o) => o.date <= endDate));
    return firstAligned(codes, filtered, endDate);
  }
}

/** Picks the latest date with values for every code from per-code observations. */
function firstAligned(
  codes: string[],
  fetched: ValetObservation[][],
  endDate: string | undefined
): { date: string; values: Record<string, number> } {
  const byDate = new Map<string, Map<string, number>>();
  for (let i = 0; i < codes.length; i++) {
    for (const obs of fetched[i]) {
      if (obs.value === null) continue;
      let row = byDate.get(obs.date);
      if (!row) {
        row = new Map();
        byDate.set(obs.date, row);
      }
      row.set(codes[i], obs.value);
    }
  }
  const dates = [...byDate.keys()].sort().reverse();
  for (const date of dates) {
    const row = byDate.get(date)!;
    if (codes.every((c) => row.has(c))) {
      const values: Record<string, number> = {};
      for (const c of codes) values[c] = row.get(c)!;
      return { date, values };
    }
  }
  throw new Error(
    `No Bank of Canada rate data found${endDate ? ` on or before ${endDate}` : ""} for ${codes.join("/")}. ` +
      "Some series are published infrequently or discontinued (RUB, SAR, VND). " +
      "Suggest: check latest_rates for the most recent published values, or use a different currency."
  );
}

// Latest-rates cache: 1 hour in memory.
let latestRatesCache: { data: LatestRatesData; fetchedAt: number } | null = null;

export interface LatestRatesData {
  date: string;
  base: "CAD";
  rates: Record<string, number>; // currency code -> CAD per 1 unit
  count: number;
  source: string;
  cached: boolean;
}

export async function getLatestRates(): Promise<LatestRatesData> {
  const now = Date.now();
  if (latestRatesCache && now - latestRatesCache.fetchedAt < 60 * 60 * 1000) {
    return { ...latestRatesCache.data, cached: true };
  }
  const url = `${VALET_BASE}/observations/group/${FX_GROUP}/json?order_dir=desc&recent=1`;
  const data = await fetchJson(url);
  const observations = data.observations ?? [];
  if (observations.length === 0) {
    throw new Error(
      "Bank of Canada Valet API returned no recent observations. Suggest: retry in a few seconds."
    );
  }
  const obs = observations[0];
  const date = typeof obs["d"] === "string" ? (obs["d"] as string) : "";
  const detail = data.seriesDetail ?? {};
  const rates: Record<string, number> = {};
  for (const key of Object.keys(detail)) {
    const code = key.startsWith("FX") && key.endsWith("CAD") ? key.slice(2, -3) : "";
    if (!code) continue;
    const raw = obs[key] as { v?: string } | undefined;
    const parsed = raw?.v !== undefined ? parseFloat(raw.v) : NaN;
    if (Number.isFinite(parsed)) rates[code] = parsed;
  }
  const result: LatestRatesData = {
    date,
    base: "CAD",
    rates,
    count: Object.keys(rates).length,
    source: SOURCE_LABEL,
    cached: false,
  };
  latestRatesCache = { data: result, fetchedAt: now };
  return result;
}

/** Rate in units of `to` per 1 unit of `from`, from CAD-per-unit values. */
export function crossRate(values: Record<string, number>, from: string, to: string): number {
  if (from === to) return 1;
  const rFrom = from === "CAD" ? 1 : values[from];
  const rTo = to === "CAD" ? 1 : values[to];
  if (rFrom === undefined || !Number.isFinite(rFrom)) {
    throw new Error(`No rate value available for ${from}`);
  }
  if (rTo === undefined || !Number.isFinite(rTo)) {
    throw new Error(`No rate value available for ${to}`);
  }
  return rFrom / rTo;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
