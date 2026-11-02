/** The shard naming contract senpi, omo and the Desktop compute identically. */
import { describe, expect, it } from "vitest";
import * as packageEntry from "../src/index.ts";
import {
	daemonDirectoryName,
	parseShardSocket,
	shardKey,
	shardSocketPath,
	shardSocketPathForKey,
} from "../src/modes/rpc/host-daemon-paths.ts";
import { runHostRequest } from "../src/modes/rpc/host-runner.ts";

/** Fixed vectors shared verbatim by the senpi, omo and desktop suites. */
const VECTORS = [
	{ kind: "p", owner: "01a0e28d-40e4-7402-bac7-8de6e76ad84c", key: "6d410ba846ba1550" },
	{ kind: "i", owner: "thread-0001", key: "da99f196e11b1cf9" },
	{ kind: "p", owner: "", key: "3ba7290d74188485" },
] as const;

describe("shard naming contract", () => {
	it("derives the fixed vectors every client pastes as literals", () => {
		for (const vector of VECTORS) {
			expect(shardKey(vector.kind, vector.owner)).toBe(vector.key);
			expect(shardSocketPath("/r", vector.kind, vector.owner)).toBe(`/r/${vector.kind}-${vector.key}.sock`);
			expect(parseShardSocket(`/r/${vector.kind}-${vector.key}.sock`)).toEqual({
				kind: vector.kind,
				key: vector.key,
			});
		}
	});

	// omo imports senpi only through the package root, so the contract must be reachable there.
	it("is exported from the package entry point", () => {
		expect(packageEntry.shardKey).toBe(shardKey);
		expect(packageEntry.shardSocketPath).toBe(shardSocketPath);
		expect(packageEntry.shardSocketPathForKey).toBe(shardSocketPathForKey);
		expect(packageEntry.daemonDirectoryName).toBe(daemonDirectoryName);
		const [vector] = VECTORS;
		expect(packageEntry.shardSocketPath("/r", vector.kind, vector.owner)).toBe(
			`/r/${vector.kind}-${vector.key}.sock`,
		);
	});

	it("is deterministic, 16 hex, key-addressable and kind-separated", () => {
		const socket = shardSocketPath("/r", "p", "01a0");
		expect(shardSocketPath("/r", "p", "01a0")).toBe(socket);
		expect(shardKey("p", "01a0")).toMatch(/^[0-9a-f]{16}$/);
		expect(socket).toBe(shardSocketPathForKey("/r", "p", shardKey("p", "01a0")));
		expect(shardSocketPath("/r", "i", "01a0")).not.toBe(socket);
	});

	it("labels no other endpoint as a shard", () => {
		for (const socket of [
			"/r/rpc.sock",
			"/r/p-6d410ba846ba155.sock",
			"/r/x-6d410ba846ba1550.sock",
			"/r/p-6D410BA846BA1550.sock",
		]) {
			expect(parseShardSocket(socket)).toBeNull();
		}
	});

	it("answers `shard_path` without a host", async () => {
		const outcome = await runHostRequest({ action: "shard_path", kind: "i", owner: "thread-0001", root: "/r" });
		expect(outcome).toEqual({
			exitCode: 0,
			payload: { kind: "i", key: "da99f196e11b1cf9", socket: "/r/i-da99f196e11b1cf9.sock" },
		});
	});
});
