import { describe, expect, it } from "vitest";
import { IdleExitDecider } from "../src/modes/rpc/host-lifecycle-policy.ts";
import { SessionRunActivity } from "../src/modes/rpc/host-run-activity.ts";

// A run emits `agent_start` on every loop iteration (a provider retry, a post-compaction continue, a
// follow-up) but `agent_settled` once, and a session can close before its settle arrives (#2713).

const WINDOW_MS = 600;

function event(type: string, sessionId = "session-1"): string {
	return JSON.stringify({ type, sessionId });
}

function decisionAfterIdleWindow(lines: readonly string[]): string {
	let now = 0;
	const runs = new SessionRunActivity();
	const decider = new IdleExitDecider(WINDOW_MS, () => now);
	const activity = () => ({ connections: 0, activeTurns: runs.busySessions });
	for (const line of lines) if (runs.observe(line)) decider.update(activity());
	decider.update(activity());
	now += WINDOW_MS;
	return decider.update(activity());
}

describe("host idle exit from the child's run events", () => {
	it("exits after a run that continued: two starts, one settle", () => {
		expect(decisionAfterIdleWindow([event("agent_start"), event("agent_start"), event("agent_settled")])).toBe(
			"exit",
		);
	});

	it("exits after a session closed mid-run without its settle", () => {
		expect(decisionAfterIdleWindow([event("agent_start"), event("session_closed")])).toBe("exit");
	});

	it("exits after two separate runs that each settled", () => {
		expect(
			decisionAfterIdleWindow([
				event("agent_start"),
				event("agent_settled"),
				event("agent_start"),
				event("agent_settled"),
			]),
		).toBe("exit");
	});

	it("stays up while a run that continued has not settled", () => {
		expect(decisionAfterIdleWindow([event("agent_start"), event("agent_start")])).toBe("active");
	});

	it("stays up while another session is still running after one closes", () => {
		expect(
			decisionAfterIdleWindow([event("agent_start", "a"), event("agent_start", "b"), event("session_closed", "a")]),
		).toBe("active");
	});

	it("ignores lines that are not a session's run event", () => {
		const runs = new SessionRunActivity();
		expect(runs.observe("not json")).toBe(false);
		expect(runs.observe(JSON.stringify({ type: "agent_start" }))).toBe(false);
		expect(runs.observe(event("message_update"))).toBe(false);
		expect(runs.busySessions).toBe(0);
	});
});
