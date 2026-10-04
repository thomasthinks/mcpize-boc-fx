/**
 * Freemium enforcement: in-memory per-day usage tracking.
 * Free tier: FREE_DAILY_LIMIT calls/day (default 200). Pro is unlimited;
 * x402 per-call billing is handled by MCPize, so only the free quota needs
 * local enforcement.
 */

export function getFreeDailyLimit(): number {
  const raw = process.env.FREE_DAILY_LIMIT;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 200;
}

/** YYYY-MM-DD in UTC — quota window is a calendar day. */
export function quotaDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const usage = new Map<string, number>();

export function clearQuotaForTests(): void {
  usage.clear();
}

export interface QuotaCheck {
  allowed: boolean;
  /** Present when not allowed — structured error payload for the tool response. */
  errorPayload?: Record<string, unknown>;
}

/** Consumes one quota unit when allowed. */
export function checkAndConsumeQuota(): QuotaCheck {
  const limit = getFreeDailyLimit();
  const day = quotaDay();
  const used = usage.get(day) ?? 0;
  if (used >= limit) {
    return {
      allowed: false,
      errorPayload: {
        error: `Free quota exceeded (${limit}/day). Subscribe to Pro for unlimited access.`,
        limit,
        window: "daily",
        suggestion: "Upgrade to the Pro plan for unlimited access, or try again tomorrow.",
      },
    };
  }
  usage.set(day, used + 1);
  return { allowed: true };
}
