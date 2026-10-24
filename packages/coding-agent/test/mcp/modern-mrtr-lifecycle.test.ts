import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	type JSONRPCMessage,
	LATEST_PROTOCOL_VERSION,
	ProgressSchema,
	ResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerConnection } from "../../src/core/extensions/builtin/mcp/connection.ts";
import { installModernRequestAdapter, type MrtrClock } from "../../src/core/extensions/builtin/mcp/modern/request.ts";
import { createMcpRequestOrigin, mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { inputResult } from "./fixtures/mrtr-2026-server.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

class Clock implements MrtrClock {
	time = 1_000_000;
	sequence = 0;
	timers = new Map<number, { at: number; callback: () => void }>();
	now = () => this.time;
	schedule = (callback: () => void, ms: number) => {
		const id = ++this.sequence;
		this.timers.set(id, { at: this.time + ms, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	};
	cancel = (id: ReturnType<typeof setTimeout>) => {
		this.timers.delete(id as unknown as number);
	};
	advance(ms: number) {
		const until = this.time + ms;
		for (;;) {
			const next = [...this.timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
			if (!next) break;
			this.time = next[1].at;
			this.timers.delete(next[0]);
			next[1].callback();
		}
		this.time = until;
	}
}

class ScriptTransport implements Transport {
	onmessage?: Transport["onmessage"];
	onclose?: Transport["onclose"];
	onerror?: Transport["onerror"];
	readonly calls: JSONRPCMessage[] = [];
	readonly cancellations: JSONRPCMessage[] = [];
	received = Promise.withResolvers<void>();
	readonly results: Array<Record<string, unknown> | undefined>;
	constructor(results: Array<Record<string, unknown> | undefined>) {
		this.results = results;
	}
	async start() {}
	async close() {
		this.onclose?.();
	}
	async send(message: JSONRPCMessage) {
		if (!("method" in message)) return;
		if (message.method === "initialize" && "id" in message) {
			this.onmessage?.({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					serverInfo: { name: "test", version: "1" },
					capabilities: { tools: {} },
				},
			});
		}
		if (message.method === "notifications/cancelled") this.cancellations.push(message);
		if (message.method !== "tools/call") return;
		this.calls.push(message);
		this.received.resolve();
		const result = this.results[this.calls.length - 1];
		if (result && "id" in message) this.onmessage?.({ jsonrpc: "2.0", id: message.id, result });
	}
	progress() {
		const message = this.calls.at(-1);
		if (message && "id" in message)
			this.onmessage?.({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: {
					progressToken: message.id,
					progress: 1,
					message: "PRIVATE_PROGRESS_CANARY",
				},
			});
	}
}
const clients: Client[] = [];
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
async function fixture(results: Array<Record<string, unknown> | undefined>) {
	vi.useFakeTimers();
	const transport = new ScriptTransport(results);
	const client = new Client({ name: "fixture", version: "1" });
	await client.connect(transport);
	clients.push(client);
	const underlying = vi.spyOn(client, "request");
	const clock = new Clock();
	await installModernRequestAdapter(client, { version: "2026-07-28" }, clock);
	const lifetime = new AbortController();
	const connection = Object.create(ServerConnection.prototype) as ServerConnection;
	Object.defineProperties(connection, {
		client: { value: client },
		state: { value: "connected" },
		generation: { value: 0 },
		onStateChange: { value: () => () => {} },
	});
	const origin = (presentation?: ReturnType<typeof mrtrTui>["presentation"], binding: object = {}) =>
		createMcpRequestOrigin({
			binding,
			connection,
			signal: lifetime.signal,
			presentation,
			serverLabel: "test",
			isCurrent: () => !lifetime.signal.aborted,
			resolveAuthority: async () => null,
		});
	return { transport, client, underlying, clock, origin, lifetime };
}

describe("MRTR deadlines and settlement", () => {
	it("supplied maxTotalTimeout is a duration from a nonzero start", async () => {
		const f = await fixture([inputResult(), { content: [{ type: "text", text: "final" }] }]);
		const ui = mrtrTui(async (_title, choices) => {
			if (choices.includes("Submit")) {
				f.clock.advance(1250);
				return "Submit";
			}
			return choices[0];
		});
		await f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation), { timeout: 1000, maxTotalTimeout: 2000 }),
		);
		expect(f.underlying.mock.calls[0]?.[2]).toMatchObject({ timeout: 1000, maxTotalTimeout: 2000 });
		expect(f.underlying.mock.calls[1]?.[2]).toMatchObject({ timeout: 750, maxTotalTimeout: 750 });
		expect(f.clock.timers.size).toBe(0);
	});
	it("omitted maxTotalTimeout uses the bounded operation duration", async () => {
		const f = await fixture([undefined]);
		const pending = f.client.callTool({ name: "test" }, undefined, { timeout: 1000 });
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await f.transport.received.promise;
		expect(f.underlying.mock.calls[0]?.[2]).toMatchObject({ maxTotalTimeout: 309000, timeout: 1000 });
		f.clock.advance(309000);
		await rejected;
		expect(f.transport.calls).toHaveLength(1);
		expect(f.transport.cancellations).toHaveLength(1);
		expect(f.clock.timers.size).toBe(0);
	});
	it("progress near the deadline cannot extend the logical operation", async () => {
		const f = await fixture([undefined]);
		const updates: unknown[] = [];
		const progressed = Promise.withResolvers<void>();
		const pending = f.client.callTool({ name: "test" }, undefined, {
			timeout: 1000,
			maxTotalTimeout: 2000,
			resetTimeoutOnProgress: true,
			onprogress: (progress) => {
				updates.push(progress);
				progressed.resolve();
			},
		});
		const rejected = expect(pending).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await f.transport.received.promise;
		f.clock.advance(1999);
		f.transport.progress();
		await progressed.promise;
		f.clock.advance(1);
		await rejected;
		expect(updates).toEqual([{ progress: 1 }]);
		expect(JSON.stringify(updates)).not.toContain("CANARY");
		expect(f.transport.cancellations).toHaveLength(1);
	});
	it("operation deadline expires while queued for TUI consent", async () => {
		const f = await fixture([inputResult(), inputResult()]);
		const shown = Promise.withResolvers<void>();
		const release = Promise.withResolvers<string | undefined>();
		const select = vi.fn(async (_title: string, _choices: string[], opts?: { signal?: AbortSignal }) => {
			shown.resolve();
			return await new Promise<string | undefined>((resolve) => {
				void release.promise.then(resolve);
				opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
			});
		});
		const ui = mrtrTui(select);
		const binding = {};
		const first = f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation, binding), { timeout: 1000, maxTotalTimeout: 10000 }),
		);
		const firstRejected = expect(first).rejects.toMatchObject({ code: "MCP_MRTR_CONTEXT_CHANGED" });
		await shown.promise;
		const secondSent = (f.transport.received = Promise.withResolvers<void>());
		const second = f.client.callTool(
			{ name: "test" },
			undefined,
			mcpRequestOptions(f.origin(ui.presentation, binding), { timeout: 1000, maxTotalTimeout: 100 }),
		);
		const secondRejected = expect(second).rejects.toMatchObject({ code: "MCP_MRTR_TIMEOUT" });
		await secondSent.promise;
		f.clock.advance(100);
		await secondRejected;
		f.lifetime.abort();
		await firstRejected;
		release.resolve(undefined);
		expect(select).toHaveBeenCalledTimes(1);
		expect(f.transport.calls).toHaveLength(2);
	});
	it("caller abort wins before continuation submission", async () => {
		const f = await fixture([inputResult()]);
		const caller = new AbortController();
		const ui = mrtrTui(async (_title, choices) => {
			if (choices.includes("Submit")) {
				caller.abort("PRIVATE_ABORT_CANARY");
				return "Submit";
			}
			return choices[0];
		});
		await expect(
			f.client.callTool(
				{ name: "test" },
				undefined,
				mcpRequestOptions(f.origin(ui.presentation), { signal: caller.signal }),
			),
		).rejects.toMatchObject({ code: "MCP_MRTR_CANCELLED" });
		expect(f.transport.calls).toHaveLength(1);
		expect(f.transport.cancellations).toHaveLength(0);
	});
	it("raw request uses the same MRTR adapter and final custom schema", async () => {
		const f = await fixture([{ resultType: "input_required", requestState: "" }, { final: 42 }]);
		const result = await f.client.request(
			{ method: "tools/call", params: { name: "test" } },
			ResultSchema.pick({}).extend({ final: ProgressSchema.shape.progress }).strip(),
		);
		expect(result).toEqual({ final: 42 });
		expect(f.transport.calls).toHaveLength(2);
		expect(f.transport.calls[1]).toMatchObject({ params: { requestState: "" } });
	});
});
