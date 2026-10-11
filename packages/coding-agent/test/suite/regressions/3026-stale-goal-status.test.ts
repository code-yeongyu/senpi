import { afterEach, describe, expect, it } from "vitest";
import {
	formatGoalForTool,
	formatGoalToolResponse,
	goalToolRenderDetails,
} from "../../../src/core/extensions/builtin/goal/format.ts";
import { renderGoalToolResult } from "../../../src/core/extensions/builtin/goal/renderers.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { updateGoalUi } from "../../../src/core/extensions/builtin/goal/ui.ts";
import { toThreadGoal } from "../../../src/modes/app-server/threads/goal-wire.ts";
import { getThemeByName } from "../../../src/modes/interactive/theme/theme.ts";
import { cleanupGoalMonitorTempDirs, createGoalStatusHarness, makeGoalContext } from "../goal-monitor-test-harness.ts";

afterEach(cleanupGoalMonitorTempDirs);

function goal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-3026",
		threadId: "thread-3026",
		objective: "Finish the work",
		status: "active",
		tokensUsed: 23,
		timeUsedSeconds: 17,
		createdAt: 100,
		updatedAt: 200,
		...overrides,
	};
}

const stopped = goal({ continuationStoppedAt: 1_000_000 });
const stoppedLabel = "Goal stopped: no progress (send a message or /goal resume)";

// senpi#3026: a stale stop renders paused without changing the persisted lifecycle.
describe("senpi#3026 stale-stopped goal displays", () => {
	it("renders a stopped status without a pursuit timer and preserves the other statuses", async () => {
		const status = createGoalStatusHarness();
		const ctx = await makeGoalContext([], "3026-status", { pendingMessages: false, status });
		updateGoalUi(ctx, goal(), 22);
		updateGoalUi(ctx, goal({ status: "paused" }));
		updateGoalUi(ctx, goal({ status: "complete" }));
		updateGoalUi(ctx, stopped, 99);

		// Exact stopped copy is the lead's requested UI contract.
		expect(status.updates).toEqual([
			{ key: "goal", text: "Pursuing goal (22s)" },
			{ key: "goal", text: "Goal paused (/goal resume)" },
			{ key: "goal", text: "Finish the work \u00b7 Goal achieved (17s)" },
			{ key: "goal", text: stoppedLabel },
		]);
	});

	it("reports the stop in /goal while retaining committed usage and ordinary status labels", () => {
		for (const state of ["active", "paused", "complete"] as const) {
			expect(formatGoalForTool(goal({ status: state }))).toContain(`Status: ${state}`);
		}
		const text = formatGoalForTool(stopped);
		expect(text).toContain("Status: stopped: no progress (send a message or /goal resume)");
		expect(text).toContain("Time used: 17s");
		expect(text).toContain("Tokens used: 23");
	});

	it.each(["light", "dark"])("renders paused-style %s tool cards from details and JSON", (themeName) => {
		const theme = getThemeByName(themeName);
		if (!theme) throw new Error(`Expected ${themeName} theme`);
		const details = goalToolRenderDetails(stopped);
		const text = formatGoalToolResponse(stopped);
		for (const renderDetails of [details, undefined]) {
			const rendered = renderGoalToolResult(
				{ content: [{ type: "text", text }], details: renderDetails },
				{ expanded: false, isPartial: false },
				theme,
			)
				.render(200)
				.join("\n");
			expect(rendered).toContain("stopped: no progress");
			expect(rendered).toContain("/goal resume");
			expect(rendered).not.toContain("active");
		}
		expect(JSON.parse(text)).toMatchObject({
			goal: { status: "paused", continuationStoppedAt: stopped.continuationStoppedAt },
		});
	});

	it("projects stale-stopped goals as paused for app-server clients without changing stored state", () => {
		for (const state of ["active", "paused", "complete"] as const) {
			expect(toThreadGoal(goal({ status: state })).status).toBe(state);
		}
		expect(toThreadGoal(stopped)).toMatchObject({ status: "paused", tokensUsed: 23, timeUsedSeconds: 17 });
		expect(stopped.status).toBe("active");
	});
});
