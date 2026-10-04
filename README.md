# boc-fx — Bank of Canada FX Rates

MCP server providing **official Bank of Canada daily foreign exchange rates** for
currency conversion and historical analysis. All data comes live from the
**Bank of Canada Valet API** (free, no API key):
https://www.bankofcanada.ca/valet/docs

## Tools

| Tool | Description |
|------|-------------|
| `convert_currency` | Convert an amount between two currencies at the most recent published rate, or the rate on a given date. Non-CAD pairs use the CAD cross-rate. |
| `fx_history` | Daily rate series between two currencies for a date range (max 5 years). |
| `latest_rates` | Most recently published BoC daily rates (base CAD), cached 1 hour. |

`convert_currency` parameters:
- `amount` (number, required) — positive amount to convert
- `from` / `to` (string, required) — 3-letter ISO currency codes, e.g. `USD`, `CAD`, `EUR`
- `date` (string, optional, `YYYY-MM-DD`) — rate on or before this date. If the date
  has no published rate (weekend/holiday), the most recent prior business day is
  used and `rate_date` reports which date was actually used.

## Data source

- **Bank of Canada Valet API**, group `FX_RATES_DAILY` (~27 currencies vs CAD).
- BoC series are quoted as **CAD per 1 unit of foreign currency**
  (e.g. `FXUSDCAD = 1.4246` means 1 USD = 1.4246 CAD).
- Cross-rate math: USD→EUR = (CAD per USD) ÷ (CAD per EUR).
- History available from 2017.
- All results return structured JSON content plus `structuredContent`.

## Limitations

- **Daily rates only** — no intraday/tick data.
- Rates are published on **business days only, around 16:30 ET**; weekends and
  Canadian holidays have no observations. Historical requests on those dates
  resolve to the nearest prior business day (never fabricated).
- CAD-cross conversions for two non-CAD currencies combine two daily rates; both
  legs come from the same effective business day.
- Rates are the BoC's daily *average* rates — indicative, not live tradeable quotes.
- Some series are stale/discontinued: RUB and SAR last published 2026-04-30, VND
  last published 2019-12-31. Conversions involving them use the last published
  value with an explicit staleness warning; `latest_rates` only includes series
  with a value on the latest published date.
- In-memory caches: latest rates 1 hour, series list 24 hours.

## Pricing

- Free: 200 calls/day (enforced in code via `FREE_DAILY_LIMIT`, default 200)
- Pro: $9/month, unlimited
- x402: $0.01 USDC per call on all tools

## Development

```bash
npm run dev      # start locally
npm test         # unit tests (vitest)
npm run build    # compile to dist/
bash test-mcp.sh # MCP protocol smoke test (server must be running)
```
