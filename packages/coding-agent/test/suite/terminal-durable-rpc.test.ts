/**
 * senpi#3226: a persistent rpc watch is the `checkpointed-rpc` durability class. Its manifest entry keeps
 * target, events and the last checkpoint through the strict parse, and the restore handler re-arms it
 * under its original `mon_` id with that checkpoint, so the watch reports what changed while detached.
 */
import { describe, expect, it } from "vitest";
import { createCheckpointedRpcRestoreHandler } from "../../src/core/extensions/builtin/terminal/durable-rpc.ts";
import type { RegisterRpcMonitorOptions } from "../../src/core/extensions/builtin/terminal/rpc-monitor-source.ts";
import type { ManifestMonitor } from "../../src/core/extensions/builtin/terminal/terminal-manifest-model.ts";
import { parseTerminalManifest } from "../../src/core/extensions/builtin/terminal/terminal-manifest-parse.ts";

const CHECKPOINT = {
	hosts: { "/tmp/h.sock": { instanceId: "i-1", generation: "7" } },
	statuses: { "/tmp/h.sock#s1": "running" },
};

const RPC_ENTRY = {
	monitorId: "mon_RPC",
	sessionId: "owner",
	description: "children status",
	runtimeKind: "rpc",
	durabilityClass: "checkpointed-rpc",
	target: "children",
	events: ["session_status", "effect_status"],
	exclude: [],
	createdAt: 1,
	expiresAt: 10_000_000_000_000,
	persistent: true,
	suspended: false,
	lastCheckpoint: null,
	deliveryPaused: false,
	fireWindow: { startMs: 1, count: 0 },
	rpcCheckpoint: CHECKPOINT,
};

function parsedEntry(): ManifestMonitor {
	const manifest = parseTerminalManifest({ monitors: [RPC_ENTRY], backgroundSessions: [], updatedAt: 2 }, {
		sessionDir: "/tmp",
		sessionId: "owner",
		kind: "terminal",
	} as never);
	const entry = manifest.monitors[0];
	if (entry === undefined) throw new Error("no monitor parsed");
	return entry;
}

describe("checkpointed-rpc durability (senpi#3226)", () => {
	it("keeps the rpc spec and checkpoint through the strict manifest parse", () => {
		expect(parsedEntry()).toMatchObject({
			runtimeKind: "rpc",
			durabilityClass: "checkpointed-rpc",
			target: "children",
			events: ["session_status", "effect_status"],
			rpcCheckpoint: CHECKPOINT,
		});
	});

	it("re-arms the watch under its mon_ id with the saved checkpoint and rebinds the runtime id", async () => {
		const armed: RegisterRpcMonitorOptions[] = [];
		const bound: Array<[string, string]> = [];
		const handler = createCheckpointedRpcRestoreHandler({
			registry: {
				pause: (ids: readonly string[]) => [...ids],
				registerRpc: async (options) => {
					armed.push(options);
					return { id: "rpc_9", monitorId: options.monitorId ?? "?", rows: [] };
				},
			},
			bindMonitorId: (monitorId, runtimeId) => bound.push([monitorId, runtimeId]),
			sessionId: () => "parent-durable",
			agentDir: "/tmp/agent",
		});

		const result = await handler(parsedEntry(), { downtimeMs: 1_000 });

		expect(result).toEqual({ outcome: "restored" });
		expect(armed[0]).toMatchObject({
			monitorId: "mon_RPC",
			target: { kind: "children", parent: "parent-durable" },
			persistent: true,
			restoredFrom: CHECKPOINT,
		});
		expect(bound).toEqual([["mon_RPC", "rpc_9"]]);
	});

	it("loses an entry that is not an rpc watch instead of arming it", async () => {
		const handler = createCheckpointedRpcRestoreHandler({
			registry: { pause: (ids: readonly string[]) => [...ids], registerRpc: async () => ({ id: "x", monitorId: "x", rows: [] }) },
			sessionId: () => undefined,
		});

		const result = await handler({ ...parsedEntry(), runtimeKind: "file" }, { downtimeMs: 0 });

		expect(result.outcome).toBe("lost");
	});

	it("a watch muted before the restart comes back muted (senpi#3381 review)", async () => {
		const paused: string[][] = [];
		const handler = createCheckpointedRpcRestoreHandler({
			registry: {
				pause: (ids: readonly string[]) => paused.push([...ids]),
				registerRpc: async () => ({ id: "rpc_9", monitorId: "mon_RPC", rows: [] }),
			} as never,
			sessionId: () => "owner",
		});

		const result = await handler({ ...parsedEntry(), deliveryPaused: true }, { remainingMs: undefined } as never);

		expect(result.outcome).toBe("muted");
		expect(paused).toEqual([["rpc_9"]]);
	});
});
