import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DRAIN_REQUEST_POLL_MS,
	type HostDrainRequest,
	watchDrainRequest,
	writeDrainRequest,
} from "../../src/modes/rpc/host-stop-intent.ts";

// senpi#3653: the drain request is the signal-free channel every platform shares. A generation polls
// its own request file; every distinct request it finds there is one drain request.
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function requestFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-drain-request-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return join(dir, "drain-request.json");
}

function watch(file: string): HostDrainRequest[] {
	const seen: HostDrainRequest[] = [];
	const stop = watchDrainRequest(file, (request) => seen.push(request), { pollMs: 20 });
	cleanups.push(stop);
	return seen;
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("generation drain request (senpi#3653)", () => {
	it("polls on the shared supersession cadence by default", () => {
		expect(DRAIN_REQUEST_POLL_MS).toBe(1_000);
	});

	it("delivers a request written after the watch armed, with who asked and why", async () => {
		const file = await requestFile();
		const seen = watch(file);

		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "stop" }, reason: "operator_drain" });
		await until(() => seen.length === 1);

		expect(seen[0]).toMatchObject({ sender: { pid: process.pid, kind: "stop" }, reason: "operator_drain" });
		expect(typeof seen[0]?.nonce).toBe("string");
	});

	it("delivers a request that was already waiting when the watch armed", async () => {
		// A request can land while the generation is still starting; its directory is its own, so a
		// request already there is addressed to it.
		const file = await requestFile();
		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "stop" }, reason: "early" });
		const seen = watch(file);

		await until(() => seen.length === 1);
		expect(seen[0]?.reason).toBe("early");
	});

	it("delivers each new request once, and never the same request twice", async () => {
		const file = await requestFile();
		const seen = watch(file);

		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "supervisor" }, reason: "first" });
		await until(() => seen.length === 1);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(seen).toHaveLength(1);

		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "supervisor" }, reason: "again" });
		await until(() => seen.length === 2);
		expect(seen.map((request) => request.reason)).toEqual(["first", "again"]);
	});

	it("ignores an unreadable request instead of draining on garbage", async () => {
		const file = await requestFile();
		const seen = watch(file);
		await writeFile(file, "{ not json");
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(seen).toHaveLength(0);
	});

	it("stops delivering once stopped", async () => {
		vi.useRealTimers();
		const file = await requestFile();
		const seen: HostDrainRequest[] = [];
		const stop = watchDrainRequest(file, (request) => seen.push(request), { pollMs: 20 });
		stop();
		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "stop" }, reason: "late" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(seen).toHaveLength(0);
	});

	it("delivers a request when it lands, without waiting for the poll (senpi#3747)", async () => {
		const file = await requestFile();
		const seen: HostDrainRequest[] = [];
		const stop = watchDrainRequest(file, (request) => seen.push(request), { pollMs: 600_000 });
		cleanups.push(stop);

		await writeDrainRequest(file, { sender: { pid: process.pid, kind: "stop" }, reason: "watched" });
		await until(() => seen.length === 1);
		expect(seen[0]?.reason).toBe("watched");
	});
});
