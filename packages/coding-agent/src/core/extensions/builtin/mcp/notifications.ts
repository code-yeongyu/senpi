// list_changed subscriptions + safe dynamic catalog updates (todo 35).
//
// Closes the gap where senpi ignored MCP list_changed notifications (codex
// precedent). We subscribe to tools/resources/prompts list_changed — and listen
// even when the server never declared the capability (gemini robustness) — then
// coalesce a burst (300ms) under a per-server burst guard (max 1 refresh/s) into
// a single re-list. On refresh, added tools enter INACTIVE (rug-pull defense),
// and removed tools are force-dropped and tombstoned so a stale execute()
// returns a clean isError instead of calling a dead entry.

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ToolExecError } from "./errors.ts";
import type { McpToolDefinition, McpToolDetails } from "./expose/register.ts";
import {
	PromptListChangedNotificationSchema,
	ResourceListChangedNotificationSchema,
	registerMcpNotificationHandler,
	ToolListChangedNotificationSchema,
} from "./notification-schemas.ts";
import type { Client } from "./wrap.ts";
import { type McpAsyncErrorSink, safeTimer } from "./wrap.ts";

export interface McpCatalogDiff {
	readonly added: string[];
	readonly removed: string[];
	readonly unchanged: string[];
}

/** Deterministic set diff between two catalogs, keyed by tool name. */
export function diffMcpToolNames(prev: readonly string[], next: readonly string[]): McpCatalogDiff {
	const prevSet = new Set(prev);
	const nextSet = new Set(next);
	return {
		added: [...nextSet].filter((name) => !prevSet.has(name)).sort(),
		removed: [...prevSet].filter((name) => !nextSet.has(name)).sort(),
		unchanged: [...nextSet].filter((name) => prevSet.has(name)).sort(),
	};
}

/** `/mcp status` delta line, e.g. `3 added (inactive), 1 removed`. */
export function formatMcpListChangedDelta(diff: McpCatalogDiff): string {
	const parts: string[] = [];
	if (diff.added.length > 0) parts.push(`${diff.added.length} added (inactive)`);
	if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
	return parts.length === 0 ? "no change" : parts.join(", ");
}

// ---------------------------------------------------------------------------
// Coalescer: burst -> single refresh, under a max-1/s/server burst guard.
// ---------------------------------------------------------------------------

export interface McpListChangeCoalescerOptions {
	readonly onRefresh: () => void | Promise<void>;
	readonly sink: McpAsyncErrorSink;
	readonly delayMs?: number;
	readonly minIntervalMs?: number;
	readonly scope?: string;
	readonly now?: () => number;
}

export interface McpListChangeCoalescer {
	notify(): void;
	dispose(): void;
}

export function createMcpListChangeCoalescer(options: McpListChangeCoalescerOptions): McpListChangeCoalescer {
	const delayMs = options.delayMs ?? 300;
	const minIntervalMs = options.minIntervalMs ?? 1000;
	const now = options.now ?? Date.now;
	const scope = options.scope ?? "mcp.list_changed";
	let timer: NodeJS.Timeout | undefined;
	let lastRefreshAt = Number.NEGATIVE_INFINITY;

	const fire = async (): Promise<void> => {
		timer = undefined;
		lastRefreshAt = now();
		await options.onRefresh();
	};

	return {
		notify(): void {
			if (timer !== undefined) return; // already scheduled -> coalesce this burst
			const sinceLast = now() - lastRefreshAt;
			const wait = Math.max(delayMs, minIntervalMs - sinceLast);
			timer = safeTimer(scope, wait, fire, options.sink);
		},
		dispose(): void {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// SDK subscription (listen even when the capability is undeclared).
// ---------------------------------------------------------------------------

/** Register list_changed handlers for tools/resources/prompts. `setNotificationHandler`
 * takes effect regardless of the server's declared capabilities. Malformed
 * notifications fail schema validation and are dropped by the SDK before
 * reaching `onChange`, so the connection stays up. */
export function subscribeMcpListChanged(client: Client, onChange: () => void): void {
	for (const schema of [
		ToolListChangedNotificationSchema,
		ResourceListChangedNotificationSchema,
		PromptListChangedNotificationSchema,
	]) {
		registerMcpNotificationHandler(client, schema, () => {
			onChange();
		});
	}
}

// ---------------------------------------------------------------------------
// Tombstone: a removed tool re-registered so a stale call fails cleanly.
// ---------------------------------------------------------------------------

export function buildMcpTombstoneDefinition(name: string, server: string): McpToolDefinition {
	return {
		name,
		label: name,
		description: `This MCP tool was removed from ${server} and is no longer available.`,
		parameters: Type.Object({}),
		executionMode: "parallel",
		async execute(): Promise<AgentToolResult<McpToolDetails | undefined>> {
			throw new ToolExecError(`tool no longer available on ${server}`, { phase: "call", serverName: server });
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolOutput", `${name} (removed)`), 0, 0);
		},
	};
}
