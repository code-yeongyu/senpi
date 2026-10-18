import { describe, expect, it } from "vitest";
import {
	DEFAULT_LOOP_LAG_ERROR_MS,
	DEFAULT_LOOP_LAG_WARN_MS,
	LOOP_LAG_TICK_MS,
	LoopLagWatchdog,
} from "../../src/modes/rpc/loop-lag-watchdog.ts";
import type { RpcHostStalledEvent } from "../../src/modes/rpc/rpc-types.ts";
import {
	createToolAttributionSpans,
	runWithSessionAttribution,
	type SessionAttribution,
	sessionActivityMark,
	sessionActivitySince,
} from "../../src/modes/rpc/session-attribution.ts";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { unknownSessionRegistry } from "./rpc-host-observer-support.ts";

/**
 * The host loop is shared by every in-process session, so a session that blocks it
 * freezes the whole daemon. The watchdog measures timer drift, blames the session (and
 * tool) whose work ran during the blocked window, and escalates a long stall to a
 * `host_stalled` lifecycle record. Time is injected; nothing here sleeps except the one
 * case that deliberately blocks the real loop.
 */

interface WatchdogHarness {
	readonly logs: string[];
	readonly records: RpcHostStalledEvent[];
	readonly watchdog: LoopLagWatchdog;
	advance(ms: number): void;
}

function createHarness(env: Record<string, string | undefined> = {}): WatchdogHarness {
	let clock = 0;
	const logs: string[] = [];
	const records: RpcHostStalledEvent[] = [];
	const watchdog = new LoopLagWatchdog({
		emit: (record) => records.push(record),
		log: (message) => logs.push(message),
		now: () => clock,
		env,
	});
	return {
		logs,
		records,
		watchdog,
		advance: (ms) => {
			clock += ms;
		},
	};
}

/** Drift the next tick observes: the block on top of the scheduled interval. */
function block(harness: WatchdogHarness, driftMs: number): void {
	harness.advance(LOOP_LAG_TICK_MS + driftMs);
	harness.watchdog.tick();
}

describe("loop lag watchdog", () => {
	it("logs nothing while drift stays below the warning threshold", () => {
		// Given an armed watchdog and an attributed session
		const harness = createHarness();
		harness.watchdog.tick();
		const spans = createToolAttributionSpans("rpc-quiet");
		spans.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read" });
		// When a tick is late by less than SENPI_RPC_LOOP_LAG_WARN_MS
		block(harness, DEFAULT_LOOP_LAG_WARN_MS - 1);
		// Then the host stays silent
		expect(harness.logs).toEqual([]);
		expect(harness.records).toEqual([]);
		spans.closeAll();
	});

	it("warns with the routing session and tool when a tool blocks the loop for 1.2s", () => {
		// Given a fake tool running for session rpc-7
		const harness = createHarness();
		harness.watchdog.tick();
		const spans = createToolAttributionSpans("rpc-7");
		spans.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "fake_block" });
		// When the loop is blocked for 1.2s inside that tool
		block(harness, 1_200);
		// Then exactly one warning names the drift, the session and the tool
		expect(harness.logs).toHaveLength(1);
		expect(harness.logs[0]).toContain("1200ms");
		expect(harness.logs[0]).toContain("rpc-7");
		expect(harness.logs[0]).toContain("fake_block");
		// ... and a warning-level stall is not escalated to a lifecycle record
		expect(harness.records).toEqual([]);
		spans.closeAll();
	});

	it("stops blaming a tool once its execution ends", () => {
		// Given a tool that has already finished for session rpc-8
		const harness = createHarness();
		harness.watchdog.tick();
		const spans = createToolAttributionSpans("rpc-8");
		spans.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "finished_tool" });
		spans.observe({ type: "tool_execution_end", toolCallId: "call-1", toolName: "finished_tool" });
		spans.observe({ type: "agent_settled" });
		// When a healthy tick passes and only then the loop stalls
		block(harness, 0);
		block(harness, 1_200);
		// Then the warning does not pin it on a tool that is no longer executing
		expect(harness.logs).toHaveLength(1);
		expect(harness.logs[0]).not.toContain("finished_tool");
		expect(harness.logs[0]).toContain("no attributed session");
	});

	it("warns at most once per 10 seconds", () => {
		// Given a host that already warned about a stall
		const harness = createHarness();
		harness.watchdog.tick();
		block(harness, 1_200);
		// When another stall happens inside the 10s window, and one after it
		block(harness, 1_200);
		expect(harness.logs).toHaveLength(1);
		harness.advance(10_000);
		block(harness, 1_200);
		// Then the throttle suppressed only the one inside the window
		expect(harness.logs).toHaveLength(2);
	});

	it("delivers host_stalled to a connected client when the loop blocks for 6s", async () => {
		// Given a writer with one connected client and a watchdog broadcasting through it
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
		let clock = 0;
		const watchdog = new LoopLagWatchdog({
			emit: (record) => writer.broadcastHostRecord(record),
			log: () => {},
			now: () => clock,
			env: {},
		});
		watchdog.tick();
		const spans = createToolAttributionSpans("rpc-9");
		spans.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "slow_tool" });
		// When the loop is blocked past SENPI_RPC_LOOP_LAG_ERROR_MS
		clock += LOOP_LAG_TICK_MS + 6_000;
		watchdog.tick();
		// Then the client receives the lifecycle record with the drift and the blamed session
		await delivered;
		expect(JSON.parse(lines[0] ?? "{}")).toEqual({
			type: "host_stalled",
			driftMs: 6_000,
			sessionId: "rpc-9",
			tool: "slow_tool",
		});
	});

	it("takes its thresholds from the environment", () => {
		// Given thresholds raised through the documented environment overrides
		const harness = createHarness({
			SENPI_RPC_LOOP_LAG_WARN_MS: "2000",
			SENPI_RPC_LOOP_LAG_ERROR_MS: "3000",
		});
		harness.watchdog.tick();
		// When a stall above the DEFAULT warning threshold but below the override lands
		block(harness, DEFAULT_LOOP_LAG_WARN_MS + 500);
		expect(harness.logs).toEqual([]);
		// ... and then one above both overrides but below the default error threshold
		block(harness, DEFAULT_LOOP_LAG_ERROR_MS - 1_000);
		// Then the overrides decide both the warning and the escalation
		expect(harness.logs).toHaveLength(1);
		expect(harness.records).toHaveLength(1);
		expect(harness.records[0]?.driftMs).toBe(DEFAULT_LOOP_LAG_ERROR_MS - 1_000);
	});

	it("blames a session whose command blocks the loop in a later continuation", async () => {
		// Given a routed command that has already yielded, with its work still in flight
		// (an extension request, a tool, a turn: the blocking code is rarely in the first
		// synchronous segment of the dispatch)
		const harness = createHarness();
		harness.watchdog.tick();
		let releaseWork: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			releaseWork = resolve;
		});
		const inFlight = runWithSessionAttribution({ sessionId: "rpc-5" }, async () => {
			await gate;
		});
		// When a healthy tick passes first and only then the continuation blocks the loop
		block(harness, 0);
		block(harness, 1_200);
		// Then the stall is still blamed on that session
		expect(harness.logs).toHaveLength(1);
		expect(harness.logs[0]).toContain("rpc-5");
		releaseWork?.();
		await inFlight;
	});

	it("blames the session whose routed command is being dispatched", async () => {
		// Given a router whose registry observes the attribution of the command it serves
		const observed: (SessionAttribution | undefined)[] = [];
		const mark = sessionActivityMark();
		const writer = new SessionEventWriter(() => {});
		const router = new SessionCommandRouter(
			unknownSessionRegistry(() => observed.push(sessionActivitySince(mark))),
			writer,
			{ cwd: process.cwd() },
		);
		// When a session command is routed
		const response = await router.handle({ type: "get_state", sessionId: "rpc-3" });
		// Then the dispatch ran attributed to that routing handle
		expect(observed).toEqual([{ sessionId: "rpc-3" }]);
		expect(response?.success).toBe(false);
	});

	it("reports how much CPU the host used and how its heap moved during a stall (senpi#2211)", () => {
		// Given probes for process CPU time and heap usage that the stalled window moves
		let clock = 0;
		let cpuMicros = 0;
		let heapBytes = 900 * 1024 * 1024;
		const records: RpcHostStalledEvent[] = [];
		const watchdog = new LoopLagWatchdog({
			emit: (record) => records.push(record),
			log: () => {},
			now: () => clock,
			cpuUsage: () => ({ user: cpuMicros, system: 0 }),
			heapUsed: () => heapBytes,
			env: {},
		});
		watchdog.tick();
		// When the loop is held 6s while the process burns 5.8s of CPU and the heap drops by 300 MB
		clock += LOOP_LAG_TICK_MS + 6_000;
		cpuMicros += 5_800_000;
		heapBytes -= 300 * 1024 * 1024;
		watchdog.tick();
		// Then the stall carries the measured CPU and heap movement of that window
		expect(records).toEqual([expect.objectContaining({ driftMs: 6_000, processCpuMs: 5_800, heapDeltaMb: -300 })]);
	});

	it("reports near-zero CPU when the host did not run during a stall (senpi#2211)", () => {
		// Given probes that do not move: the process was not scheduled during the window
		let clock = 0;
		const logs: string[] = [];
		const records: RpcHostStalledEvent[] = [];
		const watchdog = new LoopLagWatchdog({
			emit: (record) => records.push(record),
			log: (message) => logs.push(message),
			now: () => clock,
			cpuUsage: () => ({ user: 1_000, system: 0 }),
			heapUsed: () => 500 * 1024 * 1024,
			env: {},
		});
		watchdog.tick();
		// When the loop is late by 7s
		clock += LOOP_LAG_TICK_MS + 7_000;
		watchdog.tick();
		// Then the stall says the host used no CPU and the heap did not move
		expect(records).toEqual([expect.objectContaining({ driftMs: 7_000, processCpuMs: 0, heapDeltaMb: 0 })]);
		expect(logs).toHaveLength(1);
	});

	it("measures a real 1.2s block through its own timer", async () => {
		// Given a watchdog armed on real timers with a captured logger
		const logs: string[] = [];
		let reportWarning: ((message: string) => void) | undefined;
		const warned = new Promise<string>((resolve) => {
			reportWarning = resolve;
		});
		const watchdog = new LoopLagWatchdog({
			emit: () => {},
			log: (message) => {
				logs.push(message);
				reportWarning?.(message);
			},
			env: {},
		});
		watchdog.start();
		const spans = createToolAttributionSpans("rpc-real");
		spans.observe({ type: "tool_execution_start", toolCallId: "call-1", toolName: "busy_tool" });
		try {
			// When real synchronous work holds the loop for 1.2s
			const until = Date.now() + 1_200;
			while (Date.now() < until) {
				/* deliberate block: this is the condition under test */
			}
			// Then the watchdog's own timer observes the drift and names the tool
			const message = await warned;
			expect(message).toContain("rpc-real");
			expect(message).toContain("busy_tool");
		} finally {
			spans.closeAll();
			watchdog.stop();
		}
	}, 20_000);
});
