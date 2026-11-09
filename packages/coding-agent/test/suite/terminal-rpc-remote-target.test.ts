/**
 * oh-my-openagent#12719: which monitor targets name a session on another device, and how an extension
 * registers the source that serves them. Local targets parse exactly as before; the remote resume position
 * survives the strict manifest parse.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import {
	type RpcRemoteSource,
	registerRpcRemoteSource,
} from "../../src/core/extensions/builtin/terminal/rpc-remote-source.ts";
import { parseRpcTarget, type RpcTarget } from "../../src/core/extensions/builtin/terminal/rpc-monitor-targets.ts";
import { parseTerminalManifest } from "../../src/core/extensions/builtin/terminal/terminal-manifest-parse.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../src/core/extensions/loader.ts";
import { registerRpcRemoteSource as publicRegisterRpcRemoteSource } from "../../src/index.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fakeSource(): { source: RpcRemoteSource } {
	return { source: { open: async () => ({ initial: { rows: [] }, stop: () => {} }) } };
}

describe("remote rpc target parsing (oh-my-openagent#12719)", () => {
	it("parses <device>/<session> and <device>/* only while a remote source is registered", () => {
		expect(parseRpcTarget("devB/s1", undefined)).toEqual({
			error: expect.stringContaining("remote targets need the omo remote surface"),
		});
		const unregister = registerRpcRemoteSource(fakeSource().source);
		cleanups.push(unregister);
		expect(parseRpcTarget("devB/s1", undefined)).toEqual({ kind: "remote", device: "devB", session: "s1" });
		expect(parseRpcTarget(" devB/* ", undefined)).toEqual({ kind: "remote", device: "devB", session: "*" });
		unregister();
		expect(parseRpcTarget("devB/s1", undefined)).toHaveProperty("error");
	});

	it("keeps every local target as it was, with a remote source registered or not", () => {
		const local: Array<[string, RpcTarget]> = [
			["children", { kind: "children", parent: "self" }],
			["all", { kind: "all" }],
			["st_abc", { kind: "task", taskId: "st_abc" }],
			["abc123", { kind: "id", id: "abc123" }],
			["/abs/dir/s.jsonl", { kind: "id", id: "/abs/dir/s.jsonl" }],
			["/abs/s", { kind: "id", id: "/abs/s" }],
			["rel/s.jsonl", { kind: "id", id: "rel/s.jsonl" }],
			["C:/Users/s.jsonl", { kind: "id", id: "C:/Users/s.jsonl" }],
			["C:/s", { kind: "id", id: "C:/s" }],
		];
		for (const [text, expected] of local) expect(parseRpcTarget(text, "self")).toEqual(expected);
		cleanups.push(registerRpcRemoteSource(fakeSource().source));
		for (const [text, expected] of local) expect(parseRpcTarget(text, "self")).toEqual(expected);
	});

	it("keeps the remote resume position through the strict manifest parse", () => {
		const rpcCheckpoint = {
			hosts: { devB: { instanceId: "remote", generation: "g1" } },
			statuses: { "devB#s1": "idle" },
			remote: { cursor: "c-9", settled: { "devB#s1": ["7"] } },
		};
		const manifest = parseTerminalManifest(
			{
				monitors: [
					{
						monitorId: "mon_R",
						sessionId: "owner",
						description: "remote",
						runtimeKind: "rpc",
						durabilityClass: "checkpointed-rpc",
						target: "devB/s1",
						createdAt: 1,
						expiresAt: null,
						persistent: true,
						suspended: false,
						lastCheckpoint: null,
						deliveryPaused: false,
						fireWindow: { startMs: 1, count: 0 },
						rpcCheckpoint,
					},
				],
				backgroundSessions: [],
				updatedAt: 2,
			},
			{ sessionDir: "/tmp", sessionId: "owner", kind: "terminal" } as never,
		);

		expect(manifest.monitors[0]?.rpcCheckpoint).toEqual(rpcCheckpoint);
	});

	it("an extension registers the source through its API; runtime invalidation removes it", async () => {
		expect(publicRegisterRpcRemoteSource).toBe(registerRpcRemoteSource);
		const runtime = createExtensionRuntime();
		try {
			await loadExtensionFromFactory(
				(pi) => {
					pi.registerRpcRemoteSource(fakeSource().source);
				},
				"/tmp",
				createEventBus(),
				runtime,
			);
			expect(parseRpcTarget("devB/s1", undefined)).toEqual({ kind: "remote", device: "devB", session: "s1" });
			runtime.invalidate();
			expect(parseRpcTarget("devB/s1", undefined)).toHaveProperty("error");
		} finally {
			runtime.invalidate();
		}
	});
});
