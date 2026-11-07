import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupHerdrReporterFixtures, herdrReporterFixture } from "./herdr-reporter-harness.ts";

const WAKE = "wake_source_state";

/** One live watch as the terminal extension broadcasts it; only `persistent` and `deadlineMs` vary here. */
function monitorState(watch: { persistent: boolean; deadlineMs: number | null }) {
	return {
		activeCount: 1,
		monitors: [{ id: "bash_1", description: "watch", paused: false, startedAtMs: 0, ...watch }],
	};
}

beforeEach(() => {
	vi.useRealTimers();
});
afterEach(async () => {
	await cleanupHerdrReporterFixtures();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("herdr lifecycle reporter: a turn and bounded work are working, open-ended sources are named on idle", () => {
	it("keeps the pane working through settlement while a DAG run is live, and idles when it clears", async () => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		f.setIdle(false);
		await f.emit("agent_start");
		await f.bus(WAKE, { source: "omo-dag", activeCount: 1 });

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "working", message: "1 DAG run" });

		// When
		f.setIdle(true);
		await f.emit("agent_settled");

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "working", message: "1 DAG run" });

		// When
		await f.bus(WAKE, { source: "omo-dag", activeCount: 0 });

		// Then
		expect(f.requests.at(-1)?.params).toEqual(expect.not.objectContaining({ message: expect.anything() }));
		expect(f.requests.at(-1)?.params.state).toBe("idle");
	});

	it("names each live source once, in a stable order, without double counting monitors or child tasks", async () => {
		// Given
		const f = await herdrReporterFixture();
		const tasks = join(f.dir, ".omo", "senpi-task", "tasks");
		mkdirSync(tasks, { recursive: true });
		writeFileSync(
			join(tasks, "child.json"),
			JSON.stringify({ status: "running", parent_session_id: "root-session" }),
		);
		await f.start();

		// When
		await f.bus("terminal_monitor_state", { activeCount: 2 });
		await f.bus(WAKE, { source: "terminal-monitors", activeCount: 2 });
		await f.bus(WAKE, { source: "senpi-task", activeCount: 3 });
		await f.bus(WAKE, { source: "terminal-background-sessions", activeCount: 1 });
		await f.bus(WAKE, { source: "senpi-codemode", activeCount: 2 });
		await f.bus(WAKE, { source: "custom-source", activeCount: 1 });

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({
			state: "working",
			message:
				"3 subagents running + 2 monitors live + 1 custom-source + 2 detached eval cells + 1 background session",
		});
	});

	it.each([
		[
			"a persistent monitor",
			"terminal_monitor_state",
			monitorState({ persistent: true, deadlineMs: null }),
			"1 monitor live",
		],
		[
			"a background terminal session",
			WAKE,
			{ source: "terminal-background-sessions", activeCount: 1 },
			"1 background session",
		],
	])("idles the pane once the turn ends while only %s is live, and names it", async (_what, event, data, message) => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		f.setIdle(false);
		await f.emit("agent_start");
		await f.bus(event, data);

		// When
		f.setIdle(true);
		await f.emit("agent_settled");

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "idle", message });
	});

	it.each([
		["a subagent", { source: "senpi-task", activeCount: 1 }, "1 subagent running"],
		["a detached eval cell", { source: "senpi-codemode", activeCount: 1 }, "1 detached eval cell"],
	])("keeps the pane working after the turn while %s will start the next one", async (_what, data, message) => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		f.setIdle(false);
		await f.emit("agent_start");
		await f.bus(WAKE, data);

		// When
		f.setIdle(true);
		await f.emit("agent_settled");

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "working", message });
	});

	it("keeps the pane working after the turn while a one-shot monitor with a deadline is live", async () => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		f.setIdle(false);
		await f.emit("agent_start");
		await f.bus("terminal_monitor_state", monitorState({ persistent: false, deadlineMs: 1_800_000 }));

		// When
		f.setIdle(true);
		await f.emit("agent_settled");

		// Then
		expect(f.requests.at(-1)?.params).toMatchObject({ state: "working", message: "1 monitor live" });
	});

	it("leaves a pending question to the blocked state instead of counting ask-user as work", async () => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		const reports = () => f.requests.filter((r) => r.method === "pane.report_agent").length;
		const before = reports();

		// When
		await f.bus(WAKE, { source: "ask-user", activeCount: 1 });

		// Then
		expect(reports()).toBe(before);
	});

	it("ignores malformed wake-source payloads and repeated identical counts", async () => {
		// Given
		const f = await herdrReporterFixture();
		await f.start();
		const before = f.requests.length;

		// When
		for (const data of [null, {}, { source: "", activeCount: 1 }, { source: "omo-dag", activeCount: "1" }])
			await f.bus(WAKE, data);
		await f.bus(WAKE, { source: "omo-dag", activeCount: 1 });
		await f.bus(WAKE, { source: "omo-dag", activeCount: 1 });

		// Then
		expect(f.requests.length).toBe(before + 1);
	});
});
