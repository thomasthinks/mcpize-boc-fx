import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response } from "express";
import { z } from "zod";
import chalk from "chalk";
import { FxError, convertCurrency, fxHistory, latestRates } from "./tools.js";
import { checkAndConsumeQuota } from "./lib/quota.js";

// ============================================================================
// Dev Logging Utilities
// ============================================================================

const isDev = process.env.NODE_ENV !== "production";

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function formatLatency(ms: number): string {
  if (ms < 100) return chalk.green(`${ms}ms`);
  if (ms < 500) return chalk.yellow(`${ms}ms`);
  return chalk.red(`${ms}ms`);
}

function truncate(str: string, maxLen = 60): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

function logRequest(method: string, params?: unknown): void {
  if (!isDev) return;

  const paramsStr = params ? chalk.gray(` ${truncate(JSON.stringify(params))}`) : "";
  console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.cyan("→")} ${method}${paramsStr}`);
}

function logResponse(method: string, result: unknown, latencyMs: number): void {
  if (!isDev) return;

  const latency = formatLatency(latencyMs);

  // For tool calls, show the result
  if (method === "tools/call" && result) {
    const resultStr = typeof result === "string" ? result : JSON.stringify(result);
    console.log(
      `${chalk.gray(`[${timestamp()}]`)} ${chalk.green("←")} ${truncate(resultStr)} ${chalk.gray(`(${latency})`)}`
    );
  } else {
    console.log(`${chalk.gray(`[${timestamp()}]`)} ${chalk.green("✓")} ${method} ${chalk.gray(`(${latency})`)}`);
  }
}

function logError(method: string, error: unknown, latencyMs: number): void {
  const latency = formatLatency(latencyMs);

  let errorMsg: string;
  if (error instanceof Error) {
    errorMsg = error.message;
  } else if (typeof error === "object" && error !== null) {
    // JSON-RPC error object has { code, message, data? }
    const rpcError = error as { message?: string; code?: number };
    errorMsg = rpcError.message || `Error ${rpcError.code || "unknown"}`;
  } else {
    errorMsg = String(error);
  }

  console.log(
    `${chalk.gray(`[${timestamp()}]`)} ${chalk.red("✖")} ${method} ${chalk.red(truncate(errorMsg))} ${chalk.gray(`(${latency})`)}`
  );
}

// ============================================================================
// MCP Server Setup
// ============================================================================

// Build a FRESH MCP server per request.
//
// In stateless streamable-HTTP mode the MCP SDK allows a Server to be connected
// to exactly ONE transport. Reusing a single module-scope instance throws
// "Already connected to a transport" on the second connection — and Cloud Run
// opens several (startup probe + real requests). So always create a new server
// (and a new transport) inside the request handler below.
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "boc-fx",
    version: "1.0.0",
  });

  // --------------------------------------------------------------------------
  // Helpers shared by every tool: freemium quota + uniform error responses.
  // --------------------------------------------------------------------------

  /** Runs `fn` behind the free-tier quota; quota breach returns isError, never throws. */
  function withQuota<Args extends object, T extends { [key: string]: unknown }>(
    fn: (args: Args) => Promise<T>
  ) {
    return async (args: Args) => {
      const quota = checkAndConsumeQuota();
      if (!quota.allowed) {
        const payload = quota.errorPayload!;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload) }],
          isError: true,
        };
      }
      try {
        const output = await fn(args);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output) }],
          structuredContent: output,
        };
      } catch (error) {
        const suggestion =
          error instanceof FxError
            ? error.suggestion
            : "Retry the call; if the error persists, the Bank of Canada Valet API may be temporarily unavailable.";
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[boc-fx] Error:`, message);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: message, suggestion }),
            },
          ],
          isError: true,
        };
      }
    };
  }

  const currencyCode = z
    .string()
    .regex(/^[A-Za-z]{3}$/, "Currency code must be exactly 3 letters, e.g. USD")
    .describe("3-letter ISO currency code (e.g. USD, CAD, EUR).");

  const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
    .describe("Date in YYYY-MM-DD format. BoC publishes rates on business days only; weekends/holidays resolve to the nearest prior business day.");

  // --------------------------------------------------------------------------
  // Tool: convert_currency
  // --------------------------------------------------------------------------
  server.registerTool(
    "convert_currency",
    {
      title: "Convert Currency (Bank of Canada Rates)",
      description:
        "Convert an amount between two currencies using official Bank of Canada daily exchange rates. " +
        "CAD is one side of all BoC rates; conversions between two non-CAD currencies use the CAD cross-rate. " +
        "Optional date uses the most recent published rate on or before that date (weekends/holidays resolve to the prior business day, reported in rate_date).",
      inputSchema: {
        amount: z.number().positive().describe("Amount to convert (positive number, e.g. 100)."),
        from: currencyCode,
        to: currencyCode,
        date: isoDate.optional().describe("Optional date in YYYY-MM-DD format. Defaults to the most recent published rate."),
      },
      outputSchema: {
        amount: z.number(),
        from: z.string(),
        to: z.string(),
        rate: z.number(),
        converted_amount: z.number(),
        rate_date: z.string(),
        requested_date: z.string().nullable(),
        source: z.string(),
      },
    },
    withQuota(async ({ amount, from, to, date }) => {
      return await convertCurrency(amount, from, to, date);
    })
  );

  // --------------------------------------------------------------------------
  // Tool: fx_history
  // --------------------------------------------------------------------------
  server.registerTool(
    "fx_history",
    {
      title: "FX Rate History (Bank of Canada)",
      description:
        "Daily exchange-rate series between two currencies from Bank of Canada data (history from 2017). " +
        "Non-CAD pairs are computed via the CAD cross-rate. Only days where BoC published rates for both currencies are included (business days only). Max range 5 years.",
      inputSchema: {
        from: currencyCode,
        to: currencyCode,
        start_date: isoDate.describe("Start of range in YYYY-MM-DD format."),
        end_date: isoDate.describe("End of range in YYYY-MM-DD format (max 5 years after start_date)."),
      },
      outputSchema: {
        from: z.string(),
        to: z.string(),
        series: z.array(z.object({ date: z.string(), rate: z.number() })),
        count: z.number(),
        source: z.string(),
      },
    },
    withQuota(async ({ from, to, start_date, end_date }) => {
      return await fxHistory(from, to, start_date, end_date);
    })
  );

  // --------------------------------------------------------------------------
  // Tool: latest_rates
  // --------------------------------------------------------------------------
  server.registerTool(
    "latest_rates",
    {
      title: "Latest Bank of Canada FX Rates",
      description:
        "The most recently published Bank of Canada daily exchange rates, all quoted as CAD per 1 unit of the foreign currency (base CAD). BoC publishes ~27 currencies, weekdays around 16:30 ET. Results are cached for 1 hour (cached:true when served from cache).",
      inputSchema: {},
      outputSchema: {
        date: z.string(),
        base: z.string(),
        rates: z.record(z.string(), z.number()),
        count: z.number(),
        cached: z.boolean(),
        source: z.string(),
      },
    },
    withQuota(async () => {
      return await latestRates();
    })
  );

  return server;
}

// ============================================================================
// Express App Setup
// ============================================================================

const app = express();
app.use(express.json());

// Health check endpoint (required for Cloud Run)
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy" });
});

// MCP endpoint with dev logging
app.post("/mcp", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const body = req.body;

  // Extract method and params from JSON-RPC request
  const method = body?.method || "unknown";
  const params = body?.params;

  // Log incoming request
  if (method === "tools/call") {
    const toolName = params?.name || "unknown";
    const toolArgs = params?.arguments;
    logRequest(`tools/call ${chalk.bold(toolName)}`, toolArgs);
  } else if (method !== "notifications/initialized") {
    logRequest(method, params);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  // Capture response body for logging
  let responseBody = "";
  const originalWrite = res.write.bind(res) as typeof res.write;
  const originalEnd = res.end.bind(res) as typeof res.end;

  res.write = function (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void), callback?: (error: Error | null | undefined) => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }
    return originalWrite(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.end = function (chunk?: unknown, encodingOrCallback?: BufferEncoding | (() => void), callback?: () => void) {
    if (chunk) {
      responseBody += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString();
    }

    // Log response
    if (method !== "notifications/initialized") {
      const latency = Date.now() - startTime;

      try {
        const rpcResponse = JSON.parse(responseBody) as { result?: unknown; error?: unknown };

        if (rpcResponse?.error) {
          logError(method, rpcResponse.error, latency);
        } else if (method === "tools/call") {
          const content = (rpcResponse?.result as { content?: Array<{ text?: string }> })?.content;
          const resultText = content?.[0]?.text;
          logResponse(method, resultText, latency);
        } else {
          logResponse(method, null, latency);
        }
      } catch {
        logResponse(method, null, latency);
      }
    }

    return originalEnd(chunk as string, encodingOrCallback as BufferEncoding, callback);
  };

  res.on("close", () => {
    transport.close();
  });

  // Fresh server instance per request (see createMcpServer above) — required for
  // stateless streamable-HTTP so a second connection never reuses a transport.
  const server = createMcpServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// JSON error handler (Express defaults to HTML errors)
app.use((_err: unknown, _req: Request, res: Response, _next: Function) => {
  res.status(500).json({ error: "Internal server error" });
});

// ============================================================================
// Start Server
// ============================================================================

const port = parseInt(process.env.PORT || "8080");
const httpServer = app.listen(port, () => {
  console.log();
  console.log(chalk.bold("MCP Server running on"), chalk.cyan(`http://localhost:${port}`));
  console.log(`  ${chalk.gray("Health:")} http://localhost:${port}/health`);
  console.log(`  ${chalk.gray("MCP:")}    http://localhost:${port}/mcp`);

  if (isDev) {
    console.log();
    console.log(chalk.gray("─".repeat(50)));
    console.log();
  }
});

// Graceful shutdown for Cloud Run (SIGTERM before kill)
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  httpServer.close(() => {
    process.exit(0);
  });
});
