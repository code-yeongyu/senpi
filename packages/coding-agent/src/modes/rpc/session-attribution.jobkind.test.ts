import { describe, expect, test } from "vitest";
import { LoopLagWatchdog } from "./loop-lag-watchdog.ts";
import {
	describeAttribution,
	openJobSpan,
	openSessionAttributionSpan,
	runWithJob,
	runWithSessionAttribution,
	sessionActivityMark,
	sessionActivitySince,
} from "./session-attribution.ts";

describe("job-kind stall attribution", () => {
	test("a finished synchronous job body is attributed over an open span", () => {
		const closeFanout = openJobSpan("fanout");
		const mark = sessionActivityMark();
		expect(runWithJob("session.parse", () => 7)).toBe(7);
		expect(sessionActivitySince(mark)?.job).toBe("session.parse");
		closeFanout();
	});

	test("otherwise the newest open span takes the blame", () => {
		const closeFanout = openJobSpan("fanout");
		const closePrepare = openJobSpan("compaction.prepare");
		const mark = sessionActivityMark();
		expect(sessionActivitySince(mark)?.job).toBe("compaction.prepare");
		closePrepare();
		closeFanout();
	});

	test("a job span inherits the ambient session and keeps an open tool span's session", () => {
		const closeTool = openSessionAttributionSpan({ sessionId: "s-tool", tool: "grep" });
		runWithSessionAttribution({ sessionId: "s1" }, () => {
			const close = openJobSpan("hook:tool_call");
			const mark = sessionActivityMark();
			expect(sessionActivitySince(mark)).toEqual({ sessionId: "s1", job: "hook:tool_call" });
			close();
		});
		closeTool();
	});

	test("an async job stays attributable until it settles", async () => {
		let release: () => void = () => undefined;
		const settled = runWithJob("history.spool", () => new Promise<void>((resolve) => (release = resolve)));
		const mark = sessionActivityMark();
		expect(sessionActivitySince(mark)?.job).toBe("history.spool");
		release();
		await settled;
	});

	test("the stall description names the job kind", () => {
		expect(describeAttribution({ sessionId: "s1", tool: "grep", job: "fanout" })).toBe(
			"sessionId=s1 tool=grep job=fanout",
		);
		expect(describeAttribution({ job: "session.parse" })).toBe("sessionId=unknown job=session.parse");
		expect(describeAttribution({ sessionId: "s1", tool: "grep" })).toBe("sessionId=s1 tool=grep");
		expect(describeAttribution(undefined)).toBe("no attributed session");
	});

	test("a stall line logged by the watchdog gains job=<kind>", () => {
		let now = 1_000;
		const lines: string[] = [];
		const watchdog = new LoopLagWatchdog({
			emit: () => undefined,
			log: (line) => lines.push(line),
			now: () => now,
			env: { SENPI_RPC_LOOP_LAG_WARN_MS: "50" },
			cpuUsage: () => ({ user: 0, system: 0 }),
			heapUsed: () => 0,
		});
		watchdog.tick();
		runWithJob("compaction.prepare", () => {
			now += 1_000;
		});
		watchdog.tick();
		expect(lines.join("")).toContain("job=compaction.prepare");
	});
});
