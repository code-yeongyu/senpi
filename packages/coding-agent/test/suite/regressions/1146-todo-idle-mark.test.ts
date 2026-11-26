import { afterEach, describe, expect, it } from "vitest";
import type { TodoPhase } from "../../../src/core/extensions/builtin/todotools/state.ts";
import { getTodoWidgetModel } from "../../../src/core/extensions/builtin/todotools/todo-widget.ts";
import { type LiveHarness, liveHarness, shipPhases } from "../todo-liveness-harness.ts";

// senpi#1146 case 1: an idle session must not draw a todo item as in progress.

function shipAndLaterPhases(): TodoPhase[] {
	return [
		...shipPhases(),
		{
			name: "Later",
			tasks: [
				{ content: "Tag the release", status: "pending" },
				{ content: "Announce it", status: "pending" },
				{ content: "Old note", status: "completed" },
			],
		},
	];
}

function activeRows(model: ReturnType<typeof getTodoWidgetModel>): string[] {
	return (model?.rows ?? []).flatMap((row) =>
		row.kind === "task" && row.task.status === "in_progress" ? [row.task.content] : [],
	);
}

function titleOf(model: ReturnType<typeof getTodoWidgetModel>): string | undefined {
	const title = model?.rows[0];
	return title?.kind === "label" ? title.text : undefined;
}

describe("todo widget model under session liveness (senpi#1146)", () => {
	it("draws no active item and a paused title counting the open items of every phase while idle", () => {
		const phases = shipAndLaterPhases();
		const model = getTodoWidgetModel(phases, { working: false });

		expect(activeRows(model)).toEqual([]);
		// Two open items in the drawn phase plus two in a later one: the count covers the whole list.
		expect(titleOf(model)).toMatch(/paused/);
		expect(titleOf(model)?.match(/\d+/g)).toEqual(["4"]);
		// Drawing only: the stored list keeps its in-progress item.
		expect(phases[0]?.tasks[1]?.status).toBe("in_progress");
	});

	it("keeps the active mark and an unpaused title while the session is working", () => {
		const model = getTodoWidgetModel(shipAndLaterPhases(), { working: true });

		expect(activeRows(model)).toEqual(["Open the pull request"]);
		expect(titleOf(model)).not.toMatch(/paused/);
	});
});

const harnesses: LiveHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("todo widget re-sync on liveness changes (senpi#1146)", () => {
	it("follows turn start, turn settle and live wake sources, and restores the working title", async () => {
		const harness = await liveHarness();
		harnesses.push(harness);

		const started = await harness.resynced(() => harness.emit("session_start"));
		expect(started).toContain("[ ] Open the pull request");
		expect(started).not.toContain("[•]");
		expect(started?.split("\n")[0]).toMatch(/paused/);

		harness.setIdle(false);
		const working = await harness.resynced(() => harness.emit("agent_start"));
		expect(working).toContain("[•] Open the pull request");
		expect(working?.split("\n")[0]).not.toMatch(/paused/);

		harness.setIdle(true);
		expect(await harness.resynced(() => harness.emit("agent_settled"))).not.toContain("[•]");

		expect(await harness.resynced(harness.wake("senpi-task", 1))).toContain("[•] Open the pull request");
		expect(await harness.resynced(harness.wake("senpi-task", 0))).not.toContain("[•]");

		expect(await harness.resynced(harness.wake("omo-dag", 1))).toContain("[•] Open the pull request");
		expect(await harness.resynced(harness.wake("omo-dag", 0))).not.toContain("[•]");
	});
});
