import { afterEach, describe, expect, it } from "vitest";
import { getJobWidgetState, type JobWidgetState } from "../../src/index.ts";
import type { Harness } from "./harness.ts";
import {
	answerWithBlenderSpec,
	BLENDER_PRINT,
	backgroundIdle,
	bashIdOf,
	createJobWidgetHarness,
	jobState,
} from "./job-widgets-support.ts";

// A credential-shaped value the job prints; the widget author must never see it.
const PRINTED_TOKEN = `ghp_${"A1b2C3d4E5".repeat(4)}`;

describe("job widgets on background bash sessions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("builds a live widget from the job's output, then freezes it as done when the job exits", async () => {
		const { harness, log } = await createJobWidgetHarness({ authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);

		const id = bashIdOf(
			await harness.session.executeTool("bash", {
				command: `${BLENDER_PRINT}; echo "export GH_TOKEN=${PRINTED_TOKEN}"; sleep 2`,
				run_in_background: true,
			}),
		);

		const pending = await log.waitFor((state) => jobState(state, id) === "pending");
		const live = await log.waitFor((state) => jobState(state, id) === "live");
		const done = await log.waitFor((state) => jobState(state, id) === "done");
		expect(log.states.indexOf(pending)).toBeLessThan(log.states.indexOf(live));
		expect(live).toMatchObject({ v: 1, sessionId: harness.sessionManager.getSessionId() });
		expect(live.jobs[0]).toMatchObject({
			id,
			kind: "bash",
			view: { title: "Blender render", headline: { text: "2", label: "rendered" } },
		});
		expect(done.jobs[0]?.view?.headline).toEqual({ text: "2", label: "rendered" });

		const authorRequests = harness.faux.getCallLog();
		expect(authorRequests).toHaveLength(1);
		const sent = JSON.stringify(authorRequests[0]?.context);
		expect(sent).toContain("Time: 00:03.90 (Saving");
		expect(sent).not.toContain(PRINTED_TOKEN);
		expect(JSON.stringify(log.states)).not.toContain(PRINTED_TOKEN);
	}, 30_000);

	it("sends job_widget_state to RPC clients through the extension event path", async () => {
		const { harness } = await createJobWidgetHarness({ authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);
		const rpcStates: JobWidgetState[] = [];
		const live = new Promise<JobWidgetState>((resolve) => {
			harness.getExtensionRunner().onRpcEvent((event) => {
				if (event.name !== "job_widget_state") return;
				const state = event.data as JobWidgetState;
				rpcStates.push(state);
				if (state.jobs.some((job) => job.state === "live")) resolve(state);
			});
		});

		const id = bashIdOf(
			await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; sleep 30`, run_in_background: true }),
		);
		try {
			const state = await live;
			expect(state.jobs).toEqual([
				expect.objectContaining({ id, kind: "bash", state: "live", updatedAtMs: expect.any(Number) }),
			]);
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: id });
		}
	}, 30_000);

	it("taps nothing, sends nothing and never asks a model when jobWidgets.enabled is false", async () => {
		const { harness, log, sessionId, bus } = await createJobWidgetHarness({ enabled: false, authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);
		const idle = backgroundIdle(bus);

		bashIdOf(
			await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; sleep 1`, run_in_background: true }),
		);
		expect(getJobWidgetState(sessionId)).toBeUndefined();
		await idle;

		expect(getJobWidgetState(sessionId)).toBeUndefined();
		expect(log.states).toEqual([]);
		expect(harness.faux.getCallLog()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	}, 30_000);
});
