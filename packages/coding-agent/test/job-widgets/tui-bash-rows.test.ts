import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionWidgetOptions } from "../../src/core/extensions/types.ts";
import {
	DONE_LINGER_MS,
	FRAME_MS,
	JOB_BASH_ROWS_TUI_KEY,
	JobBashRows,
} from "../../src/core/extensions/builtin/job-widgets/tui-bash-rows.ts";
import type { JobWidgetEntry, JobWidgetState } from "../../src/core/extensions/builtin/job-widgets/view-types.ts";

const START = 1_000_000;

function bash(id: string, state: JobWidgetEntry["state"], extra: Partial<JobWidgetEntry> = {}): JobWidgetEntry {
	if (state === "skipped") return { id, kind: "bash", state, updatedAtMs: START };
	return {
		id,
		kind: "bash",
		state,
		updatedAtMs: START,
		startedAtMs: START,
		view: { title: `sleep 90 # ${id}`, blocks: [], lines: 0 },
		...extra,
	};
}

function stateOf(...jobs: JobWidgetEntry[]): JobWidgetState {
	return { v: 1, sessionId: "s1", jobs };
}

class FakeHost {
	component: Component | undefined;
	placement: ExtensionWidgetOptions["placement"];
	sets = 0;
	renders = 0;
	readonly tui = { requestRender: () => this.renders++ } as unknown as TUI;

	setWidget = (
		key: string,
		content: ((tui: TUI) => Component) | undefined,
		options?: ExtensionWidgetOptions,
	): void => {
		expect(key).toBe(JOB_BASH_ROWS_TUI_KEY);
		this.sets += 1;
		this.placement = options?.placement;
		this.component = content?.(this.tui);
	};

	lines(width = 100): string[] {
		return (this.component?.render(width) ?? []).map((line) => line.trim());
	}
}

describe("background bash rows below the editor", () => {
	let host: FakeHost;
	let rows: JobBashRows;

	beforeEach(() => {
		vi.useFakeTimers({ now: START });
		host = new FakeHost();
		rows = new JobBashRows({ setWidget: host.setWidget });
	});
	afterEach(() => {
		rows.dispose();
		vi.useRealTimers();
	});

	it("shows a silent running job below the editor like a subagent row, ticking its spinner and elapsed time", async () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		expect(host.placement).toBe("belowEditor");
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_1 · bash_1 · running · 0s"]);

		await vi.advanceTimersByTimeAsync(65_000 + FRAME_MS);
		expect(host.lines()).toEqual(["⠙ sleep 90 # bash_1 · bash_1 · running · 1m 5s"]);
		expect(host.sets).toBe(1);
		expect(host.renders).toBeGreaterThan(0);
	});

	it("uses a live spec's headline in place of running and keeps one row per job, newest first", () => {
		rows.update(
			stateOf(
				bash("bash_1", "pending"),
				bash("bash_2", "live", {
					view: { title: "Blender render", headline: { label: "rendered", text: "4" }, blocks: [] },
				}),
			),
		);
		expect(host.lines()).toEqual([
			"⠋ Blender render · bash_2 · rendered 4 · 0s",
			"⠋ sleep 90 # bash_1 · bash_1 · running · 0s",
		]);
	});

	it("turns an exited job into a done row with its final time, then drops it after the linger", async () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		await vi.advanceTimersByTimeAsync(8_000);
		rows.update(stateOf());
		expect(host.lines()).toEqual(["✓ sleep 90 # bash_1 · bash_1 · done · 8s"]);

		await vi.advanceTimersByTimeAsync(DONE_LINGER_MS - 1);
		expect(host.lines()).toEqual(["✓ sleep 90 # bash_1 · bash_1 · done · 8s"]);
		await vi.advanceTimersByTimeAsync(1);
		expect(host.component).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shows a skipped job done when it exits and never shows a job that was already done when first seen", () => {
		rows.update(stateOf(bash("bash_1", "done"), bash("bash_2", "fallback")));
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_2 · bash_2 · running · 0s"]);
		rows.update(stateOf(bash("bash_1", "done"), bash("bash_2", "skipped")));
		expect(host.lines()).toEqual(["✓ sleep 90 # bash_2 · bash_2 · done · 0s"]);
	});

	it("leaves task jobs alone, caps at five rows plus +N more, and fits the width", () => {
		const jobs = Array.from({ length: 7 }, (_, index) => bash(`bash_${index}`, "fallback"));
		const task: JobWidgetEntry = { ...bash("st_1", "live"), kind: "task" };
		rows.update(stateOf(task, ...jobs));
		const lines = host.lines(30);
		expect(lines).toHaveLength(6);
		expect(lines.at(-1)).toBe("+2 more");
		expect(lines.join("\n")).not.toContain("st_1");
		for (const line of host.component?.render(30) ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("stops ticking once nothing runs and removes the widget on dispose", () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		rows.dispose();
		expect(host.component).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});
