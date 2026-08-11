import { describe, expect, it } from "vitest";
import { classifySleepWait } from "../../src/core/extensions/builtin/terminal/tools/sleep-wait.ts";

describe("classifySleepWait", () => {
	describe("R1 pure sleep", () => {
		it("matches a bare long sleep", () => {
			expect(classifySleepWait("sleep 270")).toEqual({ kind: "sleep-wait", rule: "R1", seconds: 270 });
		});

		it("ignores a short settle sleep below the threshold", () => {
			expect(classifySleepWait("sleep 3")).toBeUndefined();
		});

		it("matches exactly at the threshold", () => {
			expect(classifySleepWait("sleep 10")).toEqual({ kind: "sleep-wait", rule: "R1", seconds: 10 });
		});
	});

	describe("R2 leading sleep chained into a check", () => {
		it("matches the canonical poll-then-check command", () => {
			expect(classifySleepWait("sleep 270; git log --oneline -2")).toEqual({
				kind: "sleep-wait",
				rule: "R2",
				seconds: 270,
			});
		});

		it("matches an && chain", () => {
			expect(classifySleepWait("sleep 45 && gh pr view 6127 --json mergeStateStatus")).toEqual({
				kind: "sleep-wait",
				rule: "R2",
				seconds: 45,
			});
		});

		it("ignores a short leading settle sleep", () => {
			expect(classifySleepWait("sleep 2 && curl -s http://localhost:3000/health")).toBeUndefined();
		});
	});

	describe("R3 polling loop", () => {
		it("matches a for-loop poll with a short sleep", () => {
			expect(classifySleepWait("for i in {1..6}; do kill -0 15598 || break; sleep 5; done")).toEqual({
				kind: "sleep-wait",
				rule: "R3",
				seconds: 5,
			});
		});

		it("matches a while-true poll", () => {
			expect(classifySleepWait("while true; do\n  sleep 30\n  ls /tmp/out || true\ndone")).toEqual({
				kind: "sleep-wait",
				rule: "R3",
				seconds: 30,
			});
		});

		it("ignores a sub-second loop delay below the loop threshold", () => {
			expect(classifySleepWait("for i in {1..5}; do sleep 0.1; done")).toBeUndefined();
		});
	});

	describe("R4 trailing sleep", () => {
		it("matches a long trailing sleep", () => {
			expect(classifySleepWait("bun run dev & sleep 30")).toEqual({ kind: "sleep-wait", rule: "R4", seconds: 30 });
		});

		it("ignores a short trailing settle sleep", () => {
			expect(classifySleepWait("pkill -9 bun 2>/dev/null; sleep 1")).toBeUndefined();
		});
	});

	describe("shell wrapper stripping", () => {
		it("sees through bash -lc quoting", () => {
			expect(classifySleepWait("bash -lc 'sleep 270; git log --oneline -2'")).toEqual({
				kind: "sleep-wait",
				rule: "R2",
				seconds: 270,
			});
		});

		it("sees through an env-prefixed sh -c wrapper", () => {
			expect(classifySleepWait('env FOO=1 sh -c "sleep 120"')).toEqual({
				kind: "sleep-wait",
				rule: "R1",
				seconds: 120,
			});
		});
	});

	describe("non-sleep commands and guards", () => {
		it("returns undefined for a command with no sleep", () => {
			expect(classifySleepWait("npm run check")).toBeUndefined();
		});

		it("does not match sleep-like words inside other tokens", () => {
			expect(classifySleepWait("./sleepless 300")).toBeUndefined();
		});

		it("never matches power-management commands", () => {
			expect(classifySleepWait("pmset -g sleep 300")).toBeUndefined();
			expect(classifySleepWait("caffeinate -i sleep 600")).toBeUndefined();
		});

		it("takes the longest sleep when several appear", () => {
			expect(classifySleepWait("sleep 15; echo mid; sleep 90")).toEqual({
				kind: "sleep-wait",
				rule: "R2",
				seconds: 90,
			});
		});
	});
});
