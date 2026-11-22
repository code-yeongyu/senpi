// senpi#3566 todo 6: the tool child's job policy (DESIGN PART 1 (c)) - per-kind backstops and retry rules, the cancel
// ladder, control liveness and the crash loop - decided over a fake clock.
import { describe, expect, it } from "vitest";
import {
	CANCEL_LADDER,
	CrashLoop,
	fixtureDeadline,
	KIND_POLICIES,
	Liveness,
	MISSED_PONGS_LIMIT,
	policyFor,
} from "./job-policy.ts";

describe("per-kind backstops", () => {
	it("follows the table, including the per-10 MB growth of spool and parse backstops", () => {
		expect(policyFor("tool.grep").backstopMs(undefined)).toBe(120_000);
		expect(policyFor("tool.read").backstopMs(undefined)).toBe(60_000);
		expect(policyFor("compaction.prepare").backstopMs(undefined)).toBe(180_000);
		expect(policyFor("history.spool").backstopMs({ lineBytes: 0 })).toBe(60_000);
		expect(policyFor("history.spool").backstopMs({ lineBytes: 25 * 1024 * 1024 })).toBe(63_000);
		expect(policyFor("session.parse").backstopMs({ bytes: 10 * 1024 * 1024 })).toBe(31_000);
		expect(policyFor("eval.cell").backstopMs(undefined)).toBeUndefined();
	});

	it("gives every table kind a user text, and marks exactly the retry-safe kinds idempotent", () => {
		for (const policy of Object.values(KIND_POLICIES)) expect(policy.userText.length).toBeGreaterThan(0);
		const idempotent = Object.entries(KIND_POLICIES)
			.filter(([, policy]) => policy.idempotent)
			.map(([kind]) => kind)
			.sort();
		expect(idempotent).toEqual(
			[
				"compaction.prepare",
				"history.spool",
				"session.parse",
				"tool.find",
				"tool.glob",
				"tool.grep",
				"tool.ls",
				"tool.read",
			].sort(),
		);
	});

	it("caps module and offload jobs at 300 s and takes the caller's idempotency", () => {
		expect(policyFor("module").backstopMs(undefined)).toBe(300_000);
		expect(policyFor("offload.grep", { deadlineMs: 2_000 }).backstopMs(undefined)).toBe(2_000);
		expect(policyFor("offload.grep", { deadlineMs: 900_000 }).backstopMs(undefined)).toBe(300_000);
		expect(policyFor("offload.grep", { idempotent: true }).idempotent).toBe(true);
		expect(policyFor("module").idempotent).toBe(false);
	});

	it("lets SENPI_TOOL_CHILD_DEADLINE_<KIND>_MS override a qa fixture kind, and only a qa kind", () => {
		const env = { SENPI_TOOL_CHILD_DEADLINE_QA_SLEEP_MS: "50", SENPI_TOOL_CHILD_DEADLINE_TOOL_GREP_MS: "1" };
		expect(policyFor("qa.sleep", { env }).backstopMs(undefined)).toBe(50);
		expect(fixtureDeadline("tool.grep", env)).toBeUndefined();
		expect(policyFor("tool.grep", { env }).backstopMs(undefined)).toBe(120_000);
	});
});

describe("CrashLoop", () => {
	it("is unavailable for 60 s after three exits within 5 s, and only then", () => {
		let now = 0;
		const loop = new CrashLoop(() => now);
		loop.recordExit();
		now = 2_000;
		loop.recordExit();
		expect(loop.unavailable()).toBe(false);
		now = 4_999;
		loop.recordExit();
		expect(loop.unavailable()).toBe(true);
		now = 4_999 + 59_999;
		expect(loop.unavailable()).toBe(true);
		now = 4_999 + 60_000;
		expect(loop.unavailable()).toBe(false);
	});

	it("does not count exits that fall out of the 5 s window", () => {
		let now = 0;
		const loop = new CrashLoop(() => now);
		for (const at of [0, 3_000, 6_000, 9_000]) {
			now = at;
			loop.recordExit();
		}
		expect(loop.unavailable()).toBe(false);
	});
});

describe("Liveness", () => {
	it("is unresponsive after three unanswered pings in a row, and a pong resets the count", () => {
		const liveness = new Liveness();
		for (let index = 0; index < MISSED_PONGS_LIMIT - 1; index++) liveness.pingSent();
		expect(liveness.unresponsive()).toBe(false);
		liveness.pongReceived();
		for (let index = 0; index < MISSED_PONGS_LIMIT; index++) liveness.pingSent();
		expect(liveness.unresponsive()).toBe(true);
	});
});

describe("cancel ladder", () => {
	it("is TERM at 5 s and KILL at 7 s after the cancel", () => {
		expect(CANCEL_LADDER).toEqual([
			{ atMs: 5_000, step: "term" },
			{ atMs: 7_000, step: "kill" },
		]);
	});
});
