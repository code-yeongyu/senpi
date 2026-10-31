import { describe, expect, test } from "vitest";
import {
	isSessionBusySnapshot,
	type SessionActivitySnapshot,
	WakeSourceTracker,
} from "../src/core/session-activity.ts";
import { classifyChildExit } from "../src/modes/rpc/host-lifecycle.ts";

const idle: SessionActivitySnapshot = {
	isStreaming: false,
	isBashRunning: false,
	isCompacting: false,
	hasSessionWork: false,
	hasActiveWakeSource: false,
};

describe("session activity contract", () => {
	test("an idle session is the only state that is not busy", () => {
		expect(isSessionBusySnapshot(idle)).toBe(false);
	});

	// One case per source that must defer host idle eviction. A source missing
	// here is a session the host would tear down mid-work.
	test.each([
		["streaming turn", { isStreaming: true }],
		["foreground bash", { isBashRunning: true }],
		["compaction", { isCompacting: true }],
		["session-work barrier", { hasSessionWork: true }],
		["published wake source", { hasActiveWakeSource: true }],
	] as Array<[string, Partial<SessionActivitySnapshot>]>)("%s keeps the session busy", (_label, overrides) => {
		expect(isSessionBusySnapshot({ ...idle, ...overrides })).toBe(true);
	});

	test("tracks background terminal jobs until they exit", () => {
		const tracker = new WakeSourceTracker();
		expect(tracker.hasActive).toBe(false);

		tracker.observe({ source: "terminal-background-sessions", activeCount: 1 });
		expect(tracker.hasActive).toBe(true);
		expect(tracker.activeSources).toEqual(["terminal-background-sessions"]);

		tracker.observe({ source: "terminal-background-sessions", activeCount: 0 });
		expect(tracker.hasActive).toBe(false);
	});

	test("keeps the session busy while any one source is still active", () => {
		const tracker = new WakeSourceTracker();
		tracker.observe({ source: "terminal-background-sessions", activeCount: 2 });
		tracker.observe({ source: "terminal-monitors", activeCount: 1 });

		tracker.observe({ source: "terminal-monitors", activeCount: 0 });

		expect(tracker.hasActive).toBe(true);
		expect(tracker.activeSources).toEqual(["terminal-background-sessions"]);
	});

	test("ignores malformed payloads instead of clearing live work", () => {
		const tracker = new WakeSourceTracker();
		tracker.observe({ source: "terminal-background-sessions", activeCount: 1 });

		for (const payload of [null, undefined, 42, "busy", {}, { source: "" }, { source: "x", activeCount: "1" }]) {
			tracker.observe(payload);
		}

		expect(tracker.hasActive).toBe(true);
	});

	test("counts child work separately when legacy background publishers remain active", () => {
		// Given a legacy background publisher with no kind.
		const tracker = new WakeSourceTracker();
		tracker.observe({ source: "terminal-monitors", activeCount: 3 });

		// When a child publisher reports live work.
		tracker.observe({ source: "senpi-task", activeCount: 2, kind: "children" });

		// Then both kinds retain their own obligation counts.
		expect(tracker.activeCounts).toEqual({ children: 2, background: 3 });
	});

	test("replaces the previous kind count when a source changes ownership", () => {
		// Given a source whose work belongs to children.
		const tracker = new WakeSourceTracker();
		tracker.observe({ source: "delivery", activeCount: 2, kind: "children" });

		// When the publisher replaces it with background work.
		tracker.observe({ source: "delivery", activeCount: 1, kind: "background" });

		// Then the old child count cannot linger.
		expect(tracker.activeCounts).toEqual({ children: 0, background: 1 });
	});

	test("removes a child count when its source drains", () => {
		// Given a child source alongside a live background source.
		const tracker = new WakeSourceTracker();
		tracker.observe({ source: "senpi-task", activeCount: 2, kind: "children" });
		tracker.observe({ source: "terminal-monitors", activeCount: 1 });

		// When all child work finishes.
		tracker.observe({ source: "senpi-task", activeCount: 0, kind: "children" });

		// Then background custody alone keeps the session busy.
		expect(tracker.activeCounts).toEqual({ children: 0, background: 1 });
		expect(tracker.hasActive).toBe(true);
	});
});

describe("supervised host exit classification", () => {
	test("treats a clean host exit as the supervisor's own idle stop", () => {
		expect(classifyChildExit(0, null)).toEqual({
			reason: "rpc host exited on its own idle policy",
			exitCode: 0,
		});
	});

	test.each([
		[1, null],
		[137, null],
		[null, "SIGKILL" as const],
		[null, "SIGSEGV" as const],
	])("reports code=%s signal=%s as a crash", (code, signal) => {
		const classified = classifyChildExit(code, signal);
		expect(classified.exitCode).toBe(1);
		expect(classified.reason).toMatch(/exited unexpectedly/);
	});
});
