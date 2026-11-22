import { describe, expect, it } from "vitest";
import {
	DEFAULT_HOST_RSS_WARN_MB,
	HOST_MEMORY_STDERR_INTERVAL_MS,
	HostMemorySampler,
} from "../../src/modes/rpc/host-memory-sampler.ts";
import type { RpcHostMemoryPressureEvent } from "../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { evictionRegistry, idleEntry } from "./rpc-host-observer-support.ts";

/**
 * Capacity is memory, never a refusal: the host reports its own memory footprint and parks idle
 * sessions sooner while it is under pressure, and never declines a session for it.
 */

const MEGABYTE = 1024 * 1024;
const IDLE_WINDOW_MS = 1_000;

interface SamplerHarness {
	readonly records: RpcHostMemoryPressureEvent[];
	readonly logs: string[];
	readonly pressure: boolean[];
	readonly sampler: HostMemorySampler;
	advance(ms: number): void;
	/** Sets the footprint; RSS follows it unless given, as it does before any memory is returned. */
	setMemoryMb(footprintMb: number, rssMb?: number): void;
	/** Replaces the kernel listing the sampler reads; tests drive swap-outs between samples. */
	setKernels(read: () => { sessionId: string; language: string; liveBytes: number; measure: string }[]): void;
	/** Replaces the main-thread heap reading. */
	setMainHeapBytes(bytes: number): void;
}

function createSampler(env: Record<string, string | undefined> = {}): SamplerHarness {
	let clock = 0;
	let footprintBytes = 0;
	let rssBytes = 0;
	let mainHeapBytes = 0;
	let kernels: () => { sessionId: string; language: string; liveBytes: number; measure: string }[] = () => [];
	const records: RpcHostMemoryPressureEvent[] = [];
	const logs: string[] = [];
	const pressure: boolean[] = [];
	const sampler = new HostMemorySampler({
		emit: (record) => records.push(record),
		sessions: () => 3,
		onPressure: (active) => pressure.push(active),
		log: (message) => logs.push(message),
		now: () => clock,
		readFootprint: () => ({ bytes: footprintBytes, measure: "phys_footprint" }),
		readRssBytes: () => rssBytes,
		readMainHeap: () => mainHeapBytes,
		readKernels: () => kernels(),
		env,
	});
	return {
		records,
		logs,
		pressure,
		sampler,
		advance: (ms) => {
			clock += ms;
		},
		setMemoryMb: (footprintMb, rssMb = footprintMb) => {
			footprintBytes = footprintMb * MEGABYTE;
			rssBytes = rssMb * MEGABYTE;
		},
		setKernels: (read) => {
			kernels = read;
		},
		setMainHeapBytes: (bytes) => {
			mainHeapBytes = bytes;
		},
	};
}

describe("host memory pressure", () => {
	it("stays silent below the threshold", () => {
		// Given a host well below SENPI_RPC_HOST_RSS_WARN_MB
		const harness = createSampler();
		harness.setMemoryMb(DEFAULT_HOST_RSS_WARN_MB - 1);
		// When it samples
		harness.sampler.sample();
		// Then nothing is reported and no pressure hook fires
		expect(harness.records).toEqual([]);
		expect(harness.logs).toEqual([]);
		expect(harness.pressure).toEqual([]);
	});

	it("reports footprint, rss and session count on every sample above the threshold, logging once per 5 minutes", () => {
		// Given a host above the threshold
		const harness = createSampler();
		const footprintMb = DEFAULT_HOST_RSS_WARN_MB + 512;
		harness.setMemoryMb(footprintMb, footprintMb + 100);
		// When it samples three times inside one stderr window and once after it
		harness.sampler.sample();
		harness.advance(30_000);
		harness.sampler.sample();
		harness.advance(HOST_MEMORY_STDERR_INTERVAL_MS);
		harness.sampler.sample();
		// Then every sample emits a lifecycle record, while stderr carries one line per window
		const record = {
			type: "host_memory_pressure",
			rssMb: footprintMb + 100,
			footprintMb,
			measure: "phys_footprint",
			sessions: 3,
			main: { heapBytes: 0 },
			kernels: [],
		};
		expect(harness.records).toEqual([record, record, record]);
		expect(harness.logs).toHaveLength(2);
		expect(harness.logs[0]).toContain(`footprintMb=${footprintMb}`);
		expect(harness.logs[0]).toContain(`rssMb=${footprintMb + 100}`);
	});

	it("raises the pressure hook on entry and releases it on recovery, exactly once each", () => {
		// Given a host that crosses the threshold and later falls back under it
		const harness = createSampler();
		harness.setMemoryMb(DEFAULT_HOST_RSS_WARN_MB + 1);
		harness.sampler.sample();
		harness.sampler.sample();
		// When memory is released
		harness.setMemoryMb(DEFAULT_HOST_RSS_WARN_MB - 100);
		harness.sampler.sample();
		harness.sampler.sample();
		// Then the consumer saw one rise and one fall, not one per sample
		expect(harness.pressure).toEqual([true, false]);
	});

	it("takes its threshold from the environment", () => {
		// Given a host configured with a 256 MB warning threshold
		const harness = createSampler({ SENPI_RPC_HOST_RSS_WARN_MB: "256" });
		harness.setMemoryMb(300);
		// When it samples well below the default threshold
		harness.sampler.sample();
		// Then the override decides
		expect(harness.records).toEqual([
			{
				type: "host_memory_pressure",
				rssMb: 300,
				footprintMb: 300,
				measure: "phys_footprint",
				sessions: 3,
				main: { heapBytes: 0 },
				kernels: [],
			},
		]);
	});

	// senpi#2261: RSS stays high after a collection or a kernel reset returns memory (2314 MB RSS
	// against a 143 MB footprint was measured), so an RSS-judged host stayed "pressured" forever.
	it("judges pressure by the footprint, so returned memory ends the episode while RSS stays high", () => {
		// Given a host whose footprint and RSS are both above the threshold
		const harness = createSampler({ SENPI_RPC_HOST_RSS_WARN_MB: "256" });
		harness.setMemoryMb(2_000, 2_300);
		harness.sampler.sample();
		// When the memory is returned: the footprint falls, RSS does not
		harness.setMemoryMb(140, 2_300);
		harness.sampler.sample();
		harness.sampler.sample();
		// Then pressure is released once and nothing more is reported
		expect(harness.pressure).toEqual([true, false]);
		expect(harness.records.map((record) => record.footprintMb)).toEqual([2_000]);
	});

	it("stays silent when only RSS is above the threshold", () => {
		// Given a host that returned its memory long ago: footprint low, RSS still high
		const harness = createSampler({ SENPI_RPC_HOST_RSS_WARN_MB: "256" });
		harness.setMemoryMb(140, 2_300);
		// When it samples
		harness.sampler.sample();
		// Then nothing is reported and idle parking is not tightened
		expect(harness.records).toEqual([]);
		expect(harness.pressure).toEqual([]);
	});

	it("delivers host_memory_pressure to a connected client", async () => {
		// Given a writer with one connected client
		const writer = new SessionEventWriter(() => {});
		const lines: string[] = [];
		const delivered = new Promise<string>((resolve) => {
			writer.registerConnection("client-1", {
				writeRaw: (chunk) => {
					lines.push(chunk);
					resolve(chunk);
				},
				waitForBackpressure: async () => {},
			});
		});
		const sampler = new HostMemorySampler({
			emit: (record) => writer.broadcastHostRecord(record),
			sessions: () => 12,
			onPressure: () => {},
			log: () => {},
			readFootprint: () => ({ bytes: (DEFAULT_HOST_RSS_WARN_MB + 8) * MEGABYTE, measure: "rss_anon" }),
			readRssBytes: () => (DEFAULT_HOST_RSS_WARN_MB + 20) * MEGABYTE,
			readMainHeap: () => 96 * MEGABYTE,
			readKernels: () => [],
			env: {},
		});
		// When a sample lands above the threshold
		sampler.sample();
		// Then the client receives the lifecycle record
		await delivered;
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			type: "host_memory_pressure",
			rssMb: DEFAULT_HOST_RSS_WARN_MB + 20,
			footprintMb: DEFAULT_HOST_RSS_WARN_MB + 8,
			measure: "rss_anon",
			sessions: 12,
			main: { heapBytes: 96 * MEGABYTE },
			kernels: [],
		});
	});

	it("halves the idle-park window while the host is under memory pressure", async () => {
		// Given a router with a one-second idle window and a session idle for 600ms
		let clock = 0;
		const entry = idleEntry(0);
		const registry = evictionRegistry(entry);
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: process.cwd() },
			undefined,
			{},
			{
				now: () => clock,
				idleEvictionMs: IDLE_WINDOW_MS,
			},
		);
		try {
			clock = 600;
			router.sweepIdleSessions();
			// Then nothing is parked yet
			expect(registry.closes).toEqual([]);
			// When the host reports memory pressure
			router.setMemoryPressure(true);
			router.sweepIdleSessions();
			// Then the same session is parked at half the window, and the host still counts it
			expect(registry.closes).toEqual(["rpc-1"]);
			expect(router.sessionCount).toBe(1);
		} finally {
			await router.dispose();
		}
	});

	it("restores the full idle-park window once pressure clears", async () => {
		// Given a router that was under memory pressure
		let clock = 0;
		const entry = idleEntry(0);
		const registry = evictionRegistry(entry);
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: process.cwd() },
			undefined,
			{},
			{ now: () => clock, idleEvictionMs: IDLE_WINDOW_MS },
		);
		try {
			router.setMemoryPressure(true);
			// When the host drops back below its memory threshold
			router.setMemoryPressure(false);
			clock = 600;
			router.sweepIdleSessions();
			// Then the full window applies again and the session keeps running
			expect(registry.closes).toEqual([]);
		} finally {
			await router.dispose();
		}
	});

	it("carries the main heap and each session's kernels on the pressure event", () => {
		// senpi#1960: one sample above the threshold names the main-thread heap and every kernel the
		// registry holds, so a client sees which session owns the pressure without an external probe.
		// Given a host above the threshold with one kernel on each of two sessions
		const harness = createSampler();
		harness.setKernels(() => [
			{ sessionId: "sess-a", language: "js", liveBytes: 220 * MEGABYTE, measure: "heap" },
			{ sessionId: "sess-b", language: "py", liveBytes: 150 * MEGABYTE, measure: "footprint" },
		]);
		harness.setMainHeapBytes(64 * MEGABYTE);
		harness.setMemoryMb(DEFAULT_HOST_RSS_WARN_MB + 512);
		// When it samples
		harness.sampler.sample();
		// Then the record carries the main heap and the per-session kernel split
		expect(harness.records).toEqual([
			{
				type: "host_memory_pressure",
				rssMb: DEFAULT_HOST_RSS_WARN_MB + 512,
				footprintMb: DEFAULT_HOST_RSS_WARN_MB + 512,
				measure: "phys_footprint",
				sessions: 3,
				main: { heapBytes: 64 * MEGABYTE },
				kernels: [
					{ sessionId: "sess-a", language: "js", liveBytes: 220 * MEGABYTE, measure: "heap" },
					{ sessionId: "sess-b", language: "py", liveBytes: 150 * MEGABYTE, measure: "footprint" },
				],
			},
		]);
	});

	it("reports a kernel without a reading yet as liveBytes 0, and a vanished kernel not at all", () => {
		// Given a host above the threshold whose kernel registry first holds a reading-less kernel
		const harness = createSampler();
		const kernels = [{ sessionId: "sess-a", language: "js", liveBytes: 0, measure: "heap" }];
		harness.setKernels(() => kernels);
		harness.setMainHeapBytes(32 * MEGABYTE);
		harness.setMemoryMb(DEFAULT_HOST_RSS_WARN_MB + 1);
		// When it samples
		harness.sampler.sample();
		// Then the kernel is present with liveBytes 0, never a stale or null number
		expect(harness.records[0]?.kernels).toEqual([
			{ sessionId: "sess-a", language: "js", liveBytes: 0, measure: "heap" },
		]);
		// When the kernel crashes out of the registry between samples
		harness.setKernels(() => []);
		harness.sampler.sample();
		// Then the next reading names no kernel rather than the stale one
		expect(harness.records[1]?.kernels).toEqual([]);
	});
});

describe("per-session memory on the session listing (#1960)", () => {
	it("publishes main and kernel heap per session row on list_sessions, and zeros without a kernel", async () => {
		// Given a router whose kernel view holds one JS kernel on its only session
		const entry = idleEntry(0);
		const registry = evictionRegistry(entry);
		const router = new SessionCommandRouter(
			registry,
			new SessionEventWriter(() => {}),
			{ cwd: process.cwd() },
			undefined,
			{},
			{ idleEvictionMs: Number.POSITIVE_INFINITY },
		);
		try {
			router.setHostMemoryView({
				mainHeapBytes: () => 48 * MEGABYTE,
				kernels: () => [{ sessionId: "rpc-1", language: "js", liveBytes: 200 * MEGABYTE, measure: "heap" }],
			});
			// When a client lists sessions
			const reply = await router.handle({ id: "list-1", type: "list_sessions", include_workers: true });
			// Then the row carries the main heap and that kernel's heap, so the owner is visible on the wire
			expect(reply).toMatchObject({
				type: "response",
				command: "list_sessions",
				success: true,
				data: {
					sessions: [
						{
							sessionId: "rpc-1",
							memory: { main_heap_bytes: 48 * MEGABYTE, kernel_heap_bytes: 200 * MEGABYTE, kernel_count: 1 },
						},
					],
				},
			});
			// When the kernel is gone from the view (crash, close)
			router.setHostMemoryView({
				mainHeapBytes: () => 48 * MEGABYTE,
				kernels: () => [],
			});
			const empty = await router.handle({ id: "list-2", type: "list_sessions", include_workers: true });
			// Then the row reports zeros, never null and never the stale kernel
			expect(empty).toMatchObject({
				data: {
					sessions: [
						{
							sessionId: "rpc-1",
							memory: { main_heap_bytes: 48 * MEGABYTE, kernel_heap_bytes: 0, kernel_count: 0 },
						},
					],
				},
			});
		} finally {
			await router.dispose();
		}
	});
});
