// Todo 35 — list_changed subscriptions + safe dynamic catalog updates.
//
// Unit-proves the 300ms coalescer (burst -> 1 refresh) + max-1/s/server burst
// guard, the catalog diff, the /mcp status delta line, and the removed-tool
// tombstone (stale execute -> isError). Integration-proves that a live fixture
// list_changed notification reaches the connection even after connect, via the
// SDK subscription (listening regardless of declared capability).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../../src/core/extensions/builtin/mcp/config-schema.ts";
import {
	ServerConnection,
	type ServerConnectionToolsChangedEvent,
} from "../../src/core/extensions/builtin/mcp/connection.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import {
	buildMcpTombstoneDefinition,
	createMcpListChangeCoalescer,
	diffMcpToolNames,
	formatMcpListChangedDelta,
	subscribeMcpListChanged,
} from "../../src/core/extensions/builtin/mcp/notifications.ts";
import { stdioFixtureCommand } from "./fixtures/spawn-fixture.ts";

const sink = { logger: { error: () => {} } };

describe("todo35 list_changed: coalescer", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("collapses a burst of 10 notifications in 100ms into exactly 1 refresh", () => {
		let refreshes = 0;
		const coalescer = createMcpListChangeCoalescer({
			delayMs: 300,
			minIntervalMs: 1000,
			onRefresh: () => {
				refreshes += 1;
			},
			sink,
		});
		for (let i = 0; i < 10; i += 1) {
			coalescer.notify();
			vi.advanceTimersByTime(10); // 10 notifications spread across 100ms
		}
		expect(refreshes).toBe(0); // still inside the 300ms window
		vi.advanceTimersByTime(300);
		expect(refreshes).toBe(1);
		coalescer.dispose();
	});

	it("burst guard: a second refresh waits out the min interval (max 1/s/server)", () => {
		let refreshes = 0;
		const coalescer = createMcpListChangeCoalescer({
			delayMs: 300,
			minIntervalMs: 1000,
			onRefresh: () => {
				refreshes += 1;
			},
			sink,
		});
		coalescer.notify();
		vi.advanceTimersByTime(300);
		expect(refreshes).toBe(1);
		// Immediately request another refresh: it must wait ~1s from the last one.
		coalescer.notify();
		vi.advanceTimersByTime(300);
		expect(refreshes).toBe(1); // still throttled
		vi.advanceTimersByTime(700);
		expect(refreshes).toBe(2);
		coalescer.dispose();
	});

	it("dispose cancels a pending refresh", () => {
		let refreshes = 0;
		const coalescer = createMcpListChangeCoalescer({
			onRefresh: () => {
				refreshes += 1;
			},
			sink,
		});
		coalescer.notify();
		coalescer.dispose();
		vi.advanceTimersByTime(5000);
		expect(refreshes).toBe(0);
	});
});

describe("todo35 list_changed: diff + delta", () => {
	it("computes added/removed/unchanged deterministically", () => {
		const diff = diffMcpToolNames(["mcp_fx_a", "mcp_fx_b", "mcp_fx_c"], ["mcp_fx_b", "mcp_fx_d", "mcp_fx_e"]);
		expect(diff).toEqual({
			added: ["mcp_fx_d", "mcp_fx_e"],
			removed: ["mcp_fx_a", "mcp_fx_c"],
			unchanged: ["mcp_fx_b"],
		});
	});

	it("formats the /mcp status delta line", () => {
		expect(formatMcpListChangedDelta({ added: ["a", "b", "c"], removed: ["d"], unchanged: [] })).toBe(
			"3 added (inactive), 1 removed",
		);
		expect(formatMcpListChangedDelta({ added: [], removed: [], unchanged: ["x"] })).toBe("no change");
	});
});

describe("todo35 list_changed: tombstone", () => {
	it("a removed tool's stale execute fails cleanly with an isError-style error", async () => {
		const tombstone = buildMcpTombstoneDefinition("mcp_fx_gone", "fx");
		await expect(
			tombstone.execute("call-1", {}, undefined, undefined, { cwd: process.cwd() } as never),
		).rejects.toThrow(/no longer available on fx/);
	});
});

describe("todo35 list_changed: subscription registers even when undeclared", () => {
	it("wires tools/resources/prompts handlers and forwards a valid notification", () => {
		const handlers: Array<(notification: unknown) => void> = [];
		const fakeClient = {
			setNotificationHandler: (_schema: unknown, handler: (notification: unknown) => void) => {
				handlers.push(handler);
			},
		};
		let changes = 0;
		subscribeMcpListChanged(fakeClient as never, () => {
			changes += 1;
		});
		// Three handlers registered regardless of any declared capability.
		expect(handlers).toHaveLength(3);
		handlers[0]?.({ method: "notifications/tools/list_changed" });
		expect(changes).toBe(1);
	});
});

// -------------------------------------------------------------------------
// Integration: a live fixture list_changed notification reaches the connection.
// -------------------------------------------------------------------------

const connections: ServerConnection[] = [];
afterEach(async () => {
	for (const connection of connections.splice(0).reverse()) await connection.dispose();
});

function serverConfig(overrides: Partial<McpServerConfig>): McpServerConfig {
	return {
		type: "stdio",
		args: [],
		enabled: true,
		lifecycle: "lazy",
		connectTimeoutMs: 4000,
		requestTimeoutMs: 4000,
		startupTimeoutMs: 250,
		idleTimeoutMin: 0,
		exposure: "auto",
		logLevel: "info",
		...overrides,
	};
}

describe("todo35 list_changed: live fixture subscription", () => {
	it("delivers a fixture list_changed to the connection after connect", async () => {
		const fixture = stdioFixtureCommand();
		const connection = new ServerConnection({
			config: serverConfig({
				command: fixture.command,
				args: [...fixture.args, "--tools", "2", "--emit-list-changed"],
			}),
			logger: createMcpLogger("fx-lc"),
			serverName: "fx-lc",
		});
		connections.push(connection);
		const client = await connection.connect();

		// Subscribe AFTER connect so we only count the post-call list_changed
		// (connect itself fires one tools_changed).
		const events: ServerConnectionToolsChangedEvent[] = [];
		connection.onToolsChanged((event) => {
			events.push(event);
		});

		// The fixture emits tools/list_changed after every tool call.
		await client.callTool({ name: "tool_1", arguments: { value: "go" } }, undefined, { timeout: 4000 });

		// Give the notification a moment to propagate.
		const deadline = Date.now() + 2000;
		while (events.length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		expect(events.length).toBeGreaterThanOrEqual(1);
	});
});
