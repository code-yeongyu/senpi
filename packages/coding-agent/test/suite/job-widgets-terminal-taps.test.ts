import { afterEach, describe, expect, it, vi } from "vitest";
import { getJobWidgetState } from "../../src/index.ts";
import type { Harness } from "./harness.ts";
import {
	answerWithBlenderSpec,
	BLENDER_PRINT,
	bashIdOf,
	createJobWidgetHarness,
	jobState,
} from "./job-widgets-support.ts";

describe("which terminal sessions get job widgets", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("taps a foreground command once it auto-detaches to the background", async () => {
		vi.stubEnv("PI_BASH_FOREGROUND_SECONDS", "1");
		const { harness, log } = await createJobWidgetHarness({ authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);

		const result = await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; sleep 30`, timeout: 120 });
		const id = bashIdOf(result);
		expect(result.details).toMatchObject({ auto_detached: true });
		try {
			const live = await log.waitFor((state) => jobState(state, id) === "live");
			expect(live.jobs.find((job) => job.id === id)?.view?.headline).toEqual({ text: "2", label: "rendered" });
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: id });
		}
	}, 30_000);

	it("withdraws a session once someone types into it with bash_input", async () => {
		const { harness, log, sessionId } = await createJobWidgetHarness({ authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);

		const id = bashIdOf(
			await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; cat`, run_in_background: true }),
		);
		try {
			await log.waitFor((state) => jobState(state, id) === "live");
			await harness.session.executeTool("bash_input", { bash_id: id, input: "Fra:3 typed by hand" });

			expect(getJobWidgetState(sessionId)?.jobs.map((job) => job.id)).not.toContain(id);
			const withdrawn = await log.waitFor((state, index) => index > 0 && jobState(state, id) === undefined);
			expect(withdrawn.jobs).toEqual([]);
		} finally {
			await harness.session.executeTool("kill_bash", { bash_id: id });
		}
	}, 30_000);
});
