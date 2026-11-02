// Server logging notifications (todo 42, logging half — tool-call progress
// already flows through callMcpTool's onprogress → the executing tool's
// onUpdate callback since W4).
//
// notifications/message routes into the per-server MCP logger with RFC-5424
// levels folded onto the logger's four methods; the server config's
// `logLevel` field (inert since W1) now filters below-threshold messages, and
// a token bucket caps bursts at 10 messages/second so a chatty server cannot
// flood the ring buffer — the final message of a burst always lands because
// the bucket refills continuously.

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpLogger } from "./log.ts";
import { LoggingMessageNotificationSchema, registerMcpNotificationHandler } from "./notification-schemas.ts";

export const MCP_LOG_RATE_LIMIT_PER_SECOND = 10;

/** RFC-5424 severity order, most→least severe. */
const LEVEL_ORDER = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"] as const;
type Rfc5424Level = (typeof LEVEL_ORDER)[number];

function severity(level: string): number {
	const index = LEVEL_ORDER.indexOf(level as Rfc5424Level);
	return index === -1 ? LEVEL_ORDER.indexOf("info") : index;
}

function loggerMethod(level: string): "debug" | "info" | "warn" | "error" {
	switch (level) {
		case "debug":
			return "debug";
		case "info":
		case "notice":
			return "info";
		case "warning":
			return "warn";
		default:
			return "error";
	}
}

export interface McpLoggingOptions {
	readonly logger: McpLogger;
	/** Minimum level to record (server config `logLevel`); default records all. */
	readonly logLevel?: string;
	readonly ratePerSecond?: number;
	/** Test seam for deterministic bucket refill. */
	readonly now?: () => number;
}

export function subscribeMcpServerLogging(client: Client, options: McpLoggingOptions): void {
	const threshold = options.logLevel === undefined ? undefined : severity(options.logLevel);
	const rate = options.ratePerSecond ?? MCP_LOG_RATE_LIMIT_PER_SECOND;
	const now = options.now ?? Date.now;
	let tokens = rate;
	let lastRefill = now();
	registerMcpNotificationHandler(client, LoggingMessageNotificationSchema, (notification) => {
		const { level, data, logger: serverLogger } = notification.params;
		if (threshold !== undefined && severity(level) > threshold) return;
		const at = now();
		tokens = Math.min(rate, tokens + ((at - lastRefill) / 1000) * rate);
		lastRefill = at;
		if (tokens < 1) return;
		tokens -= 1;
		const text = typeof data === "string" ? data : JSON.stringify(data);
		options.logger[loggerMethod(level)](`[server${serverLogger ? `:${serverLogger}` : ""}] ${text}`);
	});
}
