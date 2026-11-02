import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, expect, it, vi } from "vitest";
import { ModernSubscriptions } from "../../src/core/extensions/builtin/mcp/modern/subscriptions.ts";
import { ModernSdkBridge } from "../../src/core/extensions/builtin/mcp/modern/sdk-bridge.ts";
import { probeStdioTransport } from "../../src/core/extensions/builtin/mcp/modern/stdio-probe.ts";
import { createMcpLogger } from "../../src/core/extensions/builtin/mcp/log.ts";
import { makeRoot } from "./fixtures/service-lifecycle.ts";

const key = "io.modelcontextprotocol/subscriptionId";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const stop of cleanup.splice(0).reverse()) await stop();
	vi.useRealTimers();
});
const discovery = {
	resultType: "complete" as const,
	supportedVersions: ["2026-07-28"],
	capabilities: {
		tools: { listChanged: true },
		prompts: { listChanged: true },
		resources: { subscribe: true, listChanged: true },
	},
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "synthetic", version: "1" } },
};
const list = (id: number): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/list" });
const notification = (
	method: string,
	id: string | number,
	notifications?: Record<string, unknown>,
): JSONRPCMessage => ({
	jsonrpc: "2.0",
	method,
	params: { _meta: { [key]: id }, ...(notifications ? { notifications } : {}) },
});
function listenId(sent: JSONRPCMessage[]): string | number {
	const listen = sent.findLast((message) => "method" in message && message.method === "subscriptions/listen");
	if (!listen || !("id" in listen) || listen.id === undefined) throw new Error("Missing listen request");
	return listen.id;
}

// #4193: exercise both negotiated transport paths, including stdio's live-ID routing.
it.each(["http", "stdio"] as const)(
	"%s correlates acknowledgments, honors the accepted subset, and cancels on close",
	async (mode) => {
		const sent: JSONRPCMessage[] = [];
		const delivered: JSONRPCMessage[] = [];
		const ended = Promise.withResolvers<void>();
		const raw: Transport = {
			async start() {},
			async close() {
				ended.resolve();
				raw.onclose?.();
			},
			async send(message) {
				sent.push(message);
				if ("method" in message && message.method === "server/discover" && "id" in message)
					raw.onmessage?.({ jsonrpc: "2.0", id: message.id, result: discovery });
				if (mode === "http" && "method" in message && message.method === "subscriptions/listen")
					await ended.promise;
			},
		};
		const transport = mode === "http" ? new ModernSdkBridge(raw, discovery, "2026-07-28") : raw;
		transport.onmessage = (message) => delivered.push(message);
		if (mode === "stdio")
			probeStdioTransport(
				transport,
				{ clientInfo: { name: "test", version: "1" }, clientCapabilities: {}, supportedVersions: ["2026-07-28"] },
				createMcpLogger("fixture", { logDir: makeRoot("subscriptions", cleanup).agentDir }),
				10000,
				"fixture",
			);
		cleanup.push(() => transport.close());
		await transport.start();
		await transport.send(list(1));
		const id = listenId(sent);
		raw.onmessage?.(notification("notifications/tools/list_changed", id)); // Before acknowledgment.
		raw.onmessage?.(notification("notifications/subscriptions/acknowledged", "other", { toolsListChanged: true }));
		raw.onmessage?.(notification("notifications/tools/list_changed", id));
		expect(delivered).toEqual([]);
		raw.onmessage?.(notification("notifications/subscriptions/acknowledged", id, { toolsListChanged: true }));
		raw.onmessage?.(notification("notifications/tools/list_changed", "other"));
		raw.onmessage?.(notification("notifications/prompts/list_changed", id)); // Not accepted.
		raw.onmessage?.(notification("notifications/resources/updated", id));
		raw.onmessage?.(notification("notifications/tools/list_changed", id));
		expect(delivered).toEqual([notification("notifications/tools/list_changed", id)]);
		await transport.close();
		expect(sent.filter((message) => "method" in message && message.method === "notifications/cancelled")).toEqual([
			expect.objectContaining({ params: expect.objectContaining({ requestId: id }) }),
		]);
	},
);

it("HTTP completion without a graceful response retries instead of retaining a dead stream", async () => {
	vi.useFakeTimers();
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(
		async (message) => {
			sent.push(message);
		},
		discovery.capabilities,
		true,
	);
	subscriptions.outgoing(list(1));
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(1000);
	expect(sent).toHaveLength(2);
	subscriptions.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])("4193 graceful response ends the stream with subscription metadata=%s", async (withMeta) => {
	vi.useFakeTimers();
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(async (message) => {
		sent.push(message);
	}, discovery.capabilities);
	subscriptions.outgoing(list(1));
	const id = listenId(sent);
	expect(
		subscriptions.incoming({
			jsonrpc: "2.0",
			id,
			result: { resultType: "complete", ...(withMeta ? { _meta: { [key]: id } } : {}) },
		}),
	).toBe(false);
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", id))).toBe(false);
	await vi.runAllTimersAsync();
	expect(sent).toHaveLength(1);
	subscriptions.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it("abrupt HTTP failure uses bounded exponential backoff and dispose cancels the pending retry", async () => {
	vi.useFakeTimers();
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(async (message) => {
		sent.push(message);
		throw new Error("Synthetic stream EOF");
	}, discovery.capabilities);
	subscriptions.outgoing(list(1));
	await Promise.resolve();
	expect(sent).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(999);
	expect(sent).toHaveLength(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(sent).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(1999);
	expect(sent).toHaveLength(2);
	await vi.advanceTimersByTimeAsync(1);
	expect(sent).toHaveLength(3);
	subscriptions.dispose();
	expect(vi.getTimerCount()).toBe(0);
	await vi.runAllTimersAsync();
	expect(sent).toHaveLength(3);
});

it("4193 paginated resource lists hand over delivery only after replacement acknowledgment", async () => {
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(async (message) => {
		sent.push(message);
	}, discovery.capabilities);
	subscriptions.outgoing(list(1));
	const first = listenId(sent);
	subscriptions.incoming(notification("notifications/subscriptions/acknowledged", first, { toolsListChanged: true }));
	subscriptions.outgoing({ jsonrpc: "2.0", id: 2, method: "resources/list" });
	subscriptions.incoming({ jsonrpc: "2.0", id: 2, result: { resources: [{ uri: "test://a" }], nextCursor: "next" } });
	expect(listenId(sent)).toBe(first);
	subscriptions.outgoing({ jsonrpc: "2.0", id: 3, method: "resources/list", params: { cursor: "next" } });
	subscriptions.incoming({ jsonrpc: "2.0", id: 3, result: { resources: [{ uri: "test://b" }] } });
	const second = listenId(sent);
	expect(second).not.toBe(first);
	expect(sent.at(-1)).toMatchObject({
		params: { notifications: { resourceSubscriptions: ["test://a", "test://b"] } },
	});
	expect(sent.filter((message) => "method" in message && message.method === "notifications/cancelled")).toEqual([]);
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", first))).toBe(true);
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", second))).toBe(false);
	subscriptions.incoming(
		notification("notifications/subscriptions/acknowledged", second, {
			toolsListChanged: true,
			resourceSubscriptions: ["test://b", "test://unrequested"],
		}),
	);
	expect(sent.at(-1)).toMatchObject({ method: "notifications/cancelled", params: { requestId: first } });
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", first))).toBe(false);
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", second))).toBe(true);
	expect(subscriptions.incoming(notification("notifications/resources/updated", first))).toBe(false);
	expect(
		subscriptions.incoming({
			jsonrpc: "2.0",
			method: "notifications/resources/updated",
			params: { _meta: { [key]: second }, uri: "test://b" },
		}),
	).toBe(true);
	subscriptions.dispose();
});

it("4193 resource updates reach refresh handlers only for an accepted URI", () => {
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(async (message) => {
		sent.push(message);
	}, discovery.capabilities);
	subscriptions.outgoing({ jsonrpc: "2.0", id: 1, method: "resources/list" });
	subscriptions.incoming({ jsonrpc: "2.0", id: 1, result: { resources: [{ uri: "test://a" }, { uri: "test://b" }] } });
	const id = listenId(sent);
	subscriptions.incoming(
		notification("notifications/subscriptions/acknowledged", id, {
			resourceSubscriptions: ["test://a", "test://unrequested"],
		}),
	);
	const refresh = vi.fn();
	for (const uri of ["test://a", "test://b", "test://unrequested", undefined]) {
		const message: JSONRPCMessage = {
			jsonrpc: "2.0",
			method: "notifications/resources/updated",
			params: { _meta: { [key]: id }, ...(uri === undefined ? {} : { uri }) },
		};
		if (subscriptions.incoming(message)) refresh(uri);
	}
	expect(refresh.mock.calls).toEqual([["test://a"]]);
	subscriptions.dispose();
});

it("4193 acknowledgment missing the required notifications object cancels and retries with backoff", async () => {
	vi.useFakeTimers();
	const sent: JSONRPCMessage[] = [];
	const subscriptions = new ModernSubscriptions(async (message) => {
		sent.push(message);
	}, discovery.capabilities);
	cleanup.push(async () => subscriptions.dispose());
	subscriptions.outgoing(list(1));
	const id = listenId(sent);
	subscriptions.incoming(notification("notifications/subscriptions/acknowledged", id));
	expect(sent.at(-1)).toMatchObject({ method: "notifications/cancelled", params: { requestId: id } });
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", id))).toBe(false);
	await vi.advanceTimersByTimeAsync(999);
	expect(listenId(sent)).toBe(id);
	await vi.advanceTimersByTimeAsync(1);
	expect(listenId(sent)).not.toBe(id);
});

it("4193 quick acknowledged disconnects grow backoff until an accepted notification proves health", async () => {
	vi.useFakeTimers();
	const sent: JSONRPCMessage[] = [];
	const drops: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
	const subscriptions = new ModernSubscriptions(
		(message) => {
			sent.push(message);
			if ("method" in message && message.method === "subscriptions/listen") {
				const drop = Promise.withResolvers<void>();
				drops.push(drop);
				return drop.promise;
			}
			return Promise.resolve();
		},
		discovery.capabilities,
		true,
	);
	cleanup.push(async () => subscriptions.dispose());
	subscriptions.outgoing(list(1));
	for (const delay of [1000, 2000, 4000]) {
		const id = listenId(sent);
		subscriptions.incoming(notification("notifications/subscriptions/acknowledged", id, { toolsListChanged: true }));
		drops.at(-1)?.resolve();
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(listenId(sent)).toBe(id);
		await vi.advanceTimersByTimeAsync(1);
		expect(listenId(sent)).not.toBe(id);
	}
	const healthy = listenId(sent);
	subscriptions.incoming(
		notification("notifications/subscriptions/acknowledged", healthy, { toolsListChanged: true }),
	);
	expect(subscriptions.incoming(notification("notifications/tools/list_changed", healthy))).toBe(true);
	drops.at(-1)?.resolve();
	await vi.advanceTimersByTimeAsync(999);
	expect(listenId(sent)).toBe(healthy);
	await vi.advanceTimersByTimeAsync(1);
	expect(listenId(sent)).not.toBe(healthy);
});

it.each([true, false])(
	"4193 concurrent resource sweeps publish only the latest complete set, latest finishes first=%s",
	(latestFirst) => {
		const sent: JSONRPCMessage[] = [];
		const subscriptions = new ModernSubscriptions(async (message) => {
			sent.push(message);
		}, discovery.capabilities);
		subscriptions.outgoing(list(1));
		const initial = listenId(sent);
		subscriptions.outgoing({ jsonrpc: "2.0", id: 2, method: "resources/list" });
		subscriptions.outgoing({ jsonrpc: "2.0", id: 3, method: "resources/list" });
		subscriptions.incoming({
			jsonrpc: "2.0",
			id: 3,
			result: { resources: [{ uri: "test://new-a" }], nextCursor: "new" },
		});
		subscriptions.incoming({
			jsonrpc: "2.0",
			id: 2,
			result: { resources: [{ uri: "test://old-a" }], nextCursor: "old" },
		});
		subscriptions.outgoing({ jsonrpc: "2.0", id: 4, method: "resources/list", params: { cursor: "old" } });
		subscriptions.outgoing({ jsonrpc: "2.0", id: 5, method: "resources/list", params: { cursor: "new" } });
		const old: JSONRPCMessage = { jsonrpc: "2.0", id: 4, result: { resources: [{ uri: "test://old-b" }] } };
		const latest: JSONRPCMessage = { jsonrpc: "2.0", id: 5, result: { resources: [{ uri: "test://new-b" }] } };
		if (!latestFirst) {
			subscriptions.incoming(old);
			expect(listenId(sent)).toBe(initial);
		}
		subscriptions.incoming(latest);
		const published = listenId(sent);
		expect(sent.at(-1)).toMatchObject({
			params: { notifications: { resourceSubscriptions: ["test://new-a", "test://new-b"] } },
		});
		if (latestFirst) {
			subscriptions.incoming(old);
			expect(listenId(sent)).toBe(published);
		}
		subscriptions.dispose();
	},
);
