import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { interruptRunningTurn } from "../src/modes/rpc/session-control-actions-data.ts";

function runningSession(turnEpoch: number): AgentSession {
	return { isStreaming: true, retryAttempt: 0, externalAdmission: { turnEpoch } } as unknown as AgentSession;
}

describe("interruptRunningTurn", () => {
	it("answers only after the stop it started has settled", async () => {
		const stopped = Promise.withResolvers<void>();
		let answered = false;
		const answer = interruptRunningTurn(runningSession(4), undefined, () => stopped.promise).then((outcome) => {
			answered = true;
			return outcome;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(answered).toBe(false);
		stopped.resolve();
		expect(await answer).toEqual({ interrupted: true, turnId: "4" });
	});

	it("does not stop anything for a turn id that is not the running turn", async () => {
		let stops = 0;
		const outcome = await interruptRunningTurn(runningSession(4), "3", async () => {
			stops += 1;
		});
		expect(outcome).toEqual({ interrupted: false, turnId: "4" });
		expect(stops).toBe(0);
	});
});
