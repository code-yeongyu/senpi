import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { type JSONRPCMessage, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import { ServerConnection } from "../../../src/core/extensions/builtin/mcp/connection.ts";
import {
	installModernRequestAdapter,
	type MrtrClock,
} from "../../../src/core/extensions/builtin/mcp/modern/request.ts";
import { createMcpRequestOrigin } from "../../../src/core/extensions/builtin/mcp/request-origin.ts";
import type { mrtrTui } from "./mrtr-presentation.ts";

class Clock implements MrtrClock {
	time = 1_000_000;
	sequence = 0;
	timers = new Map<number, { at: number; callback: () => void }>();
	schedules = new Map<number, Array<() => void>>();
	nextScheduled(ms: number): Promise<void> {
		return new Promise((resolve) => {
			const listeners = this.schedules.get(ms) ?? [];
			listeners.push(resolve);
			this.schedules.set(ms, listeners);
		});
	}
	now = () => this.time;
	schedule = (callback: () => void, ms: number) => {
		const id = ++this.sequence;
		this.timers.set(id, { at: this.time + ms, callback });
		for (const listener of this.schedules.get(ms) ?? []) listener();
		this.schedules.delete(ms);
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
	readonly tasks: boolean;
	constructor(results: Array<Record<string, unknown> | undefined>, tasks = false) {
		this.results = results;
		this.tasks = tasks;
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
					capabilities: {
						tools: {},
						...(this.tasks ? { extensions: { "io.modelcontextprotocol/tasks": {} } } : {}),
					},
				},
			});
		}
		if (message.method === "notifications/cancelled") this.cancellations.push(message);
		if (message.method !== "tools/call" && !message.method.startsWith("tasks/")) return;
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
export async function cleanupMrtrLifecycle() {
	for (const client of clients.splice(0)) await client.close();
	vi.restoreAllMocks();
	vi.useRealTimers();
}
export async function fixture(results: Array<Record<string, unknown> | undefined>, tasks = false) {
	vi.useFakeTimers();
	const transport = new ScriptTransport(results, tasks);
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
