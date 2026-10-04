import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertCurrency, fxHistory, latestRates, FxError } from "../src/tools.js";
import { crossRate } from "../src/lib/valet.js";
import { clearCachesForTests } from "../src/lib/valet.js";
import { clearQuotaForTests, checkAndConsumeQuota, getFreeDailyLimit } from "../src/lib/quota.js";

// ============================================================================
// Fixtures — shaped like real Bank of Canada Valet API responses
// ============================================================================

function seriesFixture(key: string, pairs: Array<[string, string]>): Record<string, unknown> {
  return {
    observations: pairs.map(([d, v]) => ({ d, [key]: { v } })),
  };
}

const USD_RECENT = seriesFixture("FXUSDCAD", [
  ["2026-10-02", "1.4246"],
  ["2026-10-01", "1.4210"],
  ["2026-09-30", "1.4155"],
]);
const EUR_RECENT = seriesFixture("FXEURCAD", [
  ["2026-10-02", "1.6037"],
  ["2026-10-01", "1.5980"],
  ["2026-09-30", "1.5901"],
]);
const RUB_RECENT = seriesFixture("FXRUBCAD", [
  ["2026-04-30", "0.01819"],
  ["2026-04-29", "0.01820"],
]);

const USD_RANGE = seriesFixture("FXUSDCAD", [
  ["2026-09-28", "1.4100"],
  ["2026-09-29", "1.4125"],
  ["2026-09-30", "1.4155"],
  ["2026-10-01", "1.4210"],
  ["2026-10-02", "1.4246"],
]);
const EUR_RANGE = seriesFixture("FXEURCAD", [
  ["2026-09-28", "1.5850"],
  ["2026-09-29", "1.5875"],
  ["2026-09-30", "1.5901"],
  ["2026-10-01", "1.5980"],
  ["2026-10-02", "1.6037"],
]);

const GROUP_FIXTURE = {
  seriesDetail: {
    FXUSDCAD: { label: "USD/CAD", description: "Daily average exchange rate of the US dollar in Canadian dollars." },
    FXEURCAD: { label: "EUR/CAD", description: "Daily average exchange rate of the euro in Canadian dollars." },
    FXRUBCAD: { label: "RUB/CAD", description: "Daily average exchange rate of the Russian rouble in Canadian dollars." },
  },
  observations: [
    {
      d: "2026-10-02",
      FXUSDCAD: { v: "1.4246" },
      FXEURCAD: { v: "1.6037" },
      FXRUBCAD: { v: "0.01819" },
    },
  ],
};

function filterByRange(
  fixture: Record<string, unknown>,
  url: string
): Record<string, unknown> {
  const u = new URL(url);
  const start = u.searchParams.get("start_date");
  const end = u.searchParams.get("end_date");
  if (!start && !end) return fixture;
  const obs = fixture.observations as Array<{ d: string }>;
  return {
    ...fixture,
    observations: obs.filter(
      (o) => (!start || o.d >= start) && (!end || o.d <= end)
    ),
  };
}

function routeFetch(url: string): Record<string, unknown> {
  if (url.includes("/observations/FXUSDCAD/json")) {
    return filterByRange(url.includes("start_date") ? USD_RANGE : USD_RECENT, url);
  }
  if (url.includes("/observations/FXEURCAD/json")) {
    return filterByRange(url.includes("start_date") ? EUR_RANGE : EUR_RECENT, url);
  }
  if (url.includes("/observations/FXRUBCAD/json")) {
    return RUB_RECENT;
  }
  if (url.includes("/observations/group/FX_RATES_DAILY/json")) {
    return GROUP_FIXTURE;
  }
  throw new Error(`unexpected URL in test: ${url}`);
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () => routeFetch(url),
    }))
  );
  clearCachesForTests();
  clearQuotaForTests();
});

// ============================================================================
// crossRate math
// ============================================================================

describe("crossRate", () => {
  it("USD->CAD uses the BoC rate directly", () => {
    expect(crossRate({ USD: 1.4246 }, "USD", "CAD")).toBeCloseTo(1.4246, 6);
  });

  it("CAD->USD inverts the BoC rate", () => {
    expect(crossRate({ USD: 1.4246 }, "CAD", "USD")).toBeCloseTo(1 / 1.4246, 6);
  });

  it("USD->EUR crosses via CAD", () => {
    expect(crossRate({ USD: 1.4246, EUR: 1.6037 }, "USD", "EUR")).toBeCloseTo(
      1.4246 / 1.6037,
      6
    );
  });

  it("same currency returns 1", () => {
    expect(crossRate({}, "CAD", "CAD")).toBe(1);
  });
});

// ============================================================================
// convertCurrency
// ============================================================================

describe("convertCurrency", () => {
  it("converts 100 USD->CAD with no date using the latest rate", async () => {
    const r = await convertCurrency(100, "USD", "CAD");
    expect(r.rate).toBeCloseTo(1.4246, 4);
    expect(r.converted_amount).toBeCloseTo(142.46, 2);
    expect(r.rate_date).toBe("2026-10-02");
    expect(r.from).toBe("USD");
    expect(r.to).toBe("CAD");
    expect(r.source).toContain("Bank of Canada");
  });

  it("converts USD->EUR via the CAD cross-rate", async () => {
    const r = await convertCurrency(100, "USD", "EUR");
    expect(r.rate).toBeCloseTo(1.4246 / 1.6037, 4);
    expect(r.converted_amount).toBeCloseTo(100 * (1.4246 / 1.6037), 2);
  });

  it("resolves a weekend date to the prior business day and says so", async () => {
    const r = await convertCurrency(100, "USD", "CAD", "2026-10-04"); // Sunday
    expect(r.rate_date).toBe("2026-10-02"); // prior Friday
    expect(r.requested_date).toBe("2026-10-04");
    expect(r.note).toContain("2026-10-02");
    expect(r.converted_amount).toBeCloseTo(142.46, 2);
  });

  it("accepts lowercase currency codes", async () => {
    const r = await convertCurrency(100, "usd", "cad");
    expect(r.converted_amount).toBeCloseTo(142.46, 2);
  });

  it("same-currency conversion needs no upstream call", async () => {
    const r = await convertCurrency(50, "CAD", "CAD");
    expect(r.rate).toBe(1);
    expect(r.converted_amount).toBe(50);
  });

  it("rejects an invalid currency code with a helpful error", async () => {
    await expect(convertCurrency(100, "XXX", "CAD")).rejects.toThrow(FxError);
    await expect(convertCurrency(100, "XXX", "CAD")).rejects.toThrow(/Unsupported currency code/);
  });

  it("rejects a malformed date", async () => {
    await expect(convertCurrency(100, "USD", "CAD", "10/02/2026")).rejects.toThrow(
      /YYYY-MM-DD/
    );
  });

  it("warns when the series is stale (discontinued RUB)", async () => {
    const r = await convertCurrency(1000, "RUB", "CAD");
    expect(r.rate_date).toBe("2026-04-30");
    expect(r.converted_amount).toBeCloseTo(18.19, 2);
    expect(r.note).toContain("Warning");
    expect(r.note).toContain("infrequently or discontinued");
  });

  it("rejects a future date", async () => {
    await expect(convertCurrency(100, "USD", "CAD", "2030-01-01")).rejects.toThrow(
      /future/
    );
  });

  it("rejects a non-positive amount", async () => {
    await expect(convertCurrency(-5, "USD", "CAD")).rejects.toThrow(FxError);
  });
});

// ============================================================================
// fxHistory
// ============================================================================

describe("fxHistory", () => {
  it("returns a parsed daily series for USD->CAD", async () => {
    const r = await fxHistory("USD", "CAD", "2026-09-28", "2026-10-02");
    expect(r.count).toBe(5);
    expect(r.series[0]).toEqual({ date: "2026-09-28", rate: 1.41 });
    expect(r.series[4]).toEqual({ date: "2026-10-02", rate: 1.4246 });
    expect(r.from).toBe("USD");
    expect(r.to).toBe("CAD");
  });

  it("computes cross-rates for USD->EUR", async () => {
    const r = await fxHistory("USD", "EUR", "2026-10-01", "2026-10-02");
    expect(r.count).toBe(2);
    expect(r.series[1].rate).toBeCloseTo(1.4246 / 1.6037, 4);
  });

  it("rejects an inverted date range", async () => {
    await expect(fxHistory("USD", "CAD", "2026-10-02", "2026-09-28")).rejects.toThrow(
      /before start_date/
    );
  });

  it("rejects a range longer than 5 years", async () => {
    await expect(fxHistory("USD", "CAD", "2017-01-01", "2026-01-01")).rejects.toThrow(
      /5 years/
    );
  });

  it("rejects a bad currency code", async () => {
    await expect(fxHistory("USD", "QQQ", "2026-09-28", "2026-10-02")).rejects.toThrow(FxError);
  });
});

// ============================================================================
// latestRates
// ============================================================================

describe("latestRates", () => {
  it("returns base CAD with real rates", async () => {
    const r = await latestRates();
    expect(r.base).toBe("CAD");
    expect(r.date).toBe("2026-10-02");
    expect(r.rates.USD).toBeCloseTo(1.4246, 4);
    expect(r.rates.EUR).toBeCloseTo(1.6037, 4);
    expect(r.count).toBe(3);
    expect(r.cached).toBe(false);
  });

  it("serves the second call from the 1-hour cache", async () => {
    await latestRates();
    const r2 = await latestRates();
    expect(r2.cached).toBe(true);
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(0);
    // group endpoint fetched exactly once across both calls
    const groupCalls = vi
      .mocked(fetch)
      .mock.calls.filter((c) => String(c[0]).includes("/group/")).length;
    expect(groupCalls).toBe(1);
  });
});

// ============================================================================
// Quota
// ============================================================================

describe("quota", () => {
  it("defaults to 200/day", () => {
    expect(getFreeDailyLimit()).toBe(200);
  });

  it("blocks after the daily limit is consumed", () => {
    vi.stubEnv("FREE_DAILY_LIMIT", "3");
    for (let i = 0; i < 3; i++) {
      expect(checkAndConsumeQuota().allowed).toBe(true);
    }
    const blocked = checkAndConsumeQuota();
    expect(blocked.allowed).toBe(false);
    expect(String(blocked.errorPayload?.error)).toContain("Free quota exceeded (3/day)");
    vi.unstubAllEnvs();
  });
});
