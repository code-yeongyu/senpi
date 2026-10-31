import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { renderBashOutputResult } from "../../src/core/extensions/builtin/terminal/tools/render.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/types.ts";
import { getJobWidgetState, type JobWidgetState } from "../../src/index.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createTestUiContext, type Harness } from "./harness.ts";
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

	beforeAll(() => initTheme("dark"));

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

	it("sends the current job_widget_state once to an RPC client that starts receiving extension events late", async () => {
		const { harness, log } = await createJobWidgetHarness({ authorAfterMs: 0 });
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);
		const id = bashIdOf(
			await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; sleep 30`, run_in_background: true }),
		);
		const late: JobWidgetState[] = [];
		let unsubscribe: (() => void) | undefined;
		try {
			await log.waitFor((state) => jobState(state, id) === "live");
			const first = new Promise<JobWidgetState>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("no job_widget_state for the late client")), 5_000);
				unsubscribe = harness.getExtensionRunner().onRpcEvent(({ name, data }) => {
					if (name !== "job_widget_state") return;
					late.push(data as JobWidgetState);
					clearTimeout(timer);
					resolve(data as JobWidgetState);
				});
			});
			expect(jobState(await first, id)).toBe("live");
			expect(late).toHaveLength(1);
		} finally {
			unsubscribe?.();
			await harness.session.executeTool("kill_bash", { bash_id: id });
		}
	}, 30_000);

	it("draws the live widget above the TUI editor and on top of bash_output, driven by job_widget_state", async () => {
		let area: Component | undefined;
		const waiters = new Set<() => void>();
		const redraw = (): void => {
			for (const waiter of [...waiters]) waiter();
		};
		const tui = { requestRender: redraw } as unknown as TUI;
		const setWidget = ((key: string, content: ((tui: TUI, theme: Theme) => Component) | undefined) => {
			if (key !== "job-widgets") return;
			area = content?.(tui, theme);
			redraw();
		}) as ExtensionUIContext["setWidget"];
		const areaLine = (accept: (line: string) => boolean): Promise<string> =>
			new Promise((resolve, reject) => {
				const check = (): void => {
					const line = area?.render(80).find(accept);
					if (line === undefined) return;
					waiters.delete(check);
					clearTimeout(timer);
					resolve(line);
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`no matching widget line: ${JSON.stringify(area?.render(80))}`));
				}, 20_000);
				waiters.add(check);
				check();
			});
		const { harness } = await createJobWidgetHarness(
			{ authorAfterMs: 0 },
			{ uiContext: createTestUiContext({ setWidget }), mode: "tui" },
		);
		harnesses.push(harness);
		harness.setResponses([answerWithBlenderSpec]);
		const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

		const pending = areaLine((line) => plain(line).includes("reading output"));
		const id = bashIdOf(
			await harness.session.executeTool("bash", { command: `${BLENDER_PRINT}; sleep 30`, run_in_background: true }),
		);
		try {
			expect(plain(await pending)).toContain(id);
			const live = plain(await areaLine((line) => plain(line).includes("rendered 2")));
			expect(live).toMatch(
				new RegExp(`^ ${id}  Blender render · seconds per frame  [▁-█]{2}  rendered 2 · 4\\.30 s$`),
			);

			const read = await harness.session.executeTool("bash_output", { bash_id: id });
			expect(read.details).toMatchObject({ jobWidget: { id, state: "live" } });
			const rendered = renderBashOutputResult(
				read as Parameters<typeof renderBashOutputResult>[0],
				{ expanded: false, isPartial: false },
				theme,
				{ lastComponent: undefined } as Parameters<typeof renderBashOutputResult>[3],
			).render(80);
			expect(plain(rendered[0] ?? "")).toMatch(
				/^Blender render · seconds per frame {2}[▁-█]{2} {2}rendered 2 · 4\.30 s$/,
			);
			expect(rendered[1]).toBe("status: running");
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
