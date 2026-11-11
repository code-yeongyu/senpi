import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DONE_LINGER_MS,
	JOB_BASH_ROWS_TUI_KEY,
	JobBashRows,
} from "../../src/core/extensions/builtin/job-widgets/tui-bash-rows.ts";
import type { JobWidgetEntry, JobWidgetState } from "../../src/core/extensions/builtin/job-widgets/view-types.ts";
import type { ExtensionWidgetOptions } from "../../src/core/extensions/types.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";

const START = 1_000_000;
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function bash(id: string, state: JobWidgetEntry["state"], extra: Partial<JobWidgetEntry> = {}): JobWidgetEntry {
	if (state === "skipped") return { id, kind: "bash", state, updatedAtMs: START, ...extra };
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

const CHART: JobWidgetEntry["view"] = {
	title: "Blender render",
	headline: { label: "rendered", text: "4" },
	blocks: [{ kind: "spark", label: "seconds per frame", values: [1, 2], min: 1, max: 2, last: "2 s" }],
};

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
		content: ((tui: TUI, theme: Theme) => Component) | undefined,
		options?: ExtensionWidgetOptions,
	): void => {
		expect(key).toBe(JOB_BASH_ROWS_TUI_KEY);
		this.sets += 1;
		this.placement = options?.placement;
		this.component = content?.(this.tui, theme);
	};

	lines(width = 100): string[] {
		return (this.component?.render(width) ?? []).map((line) => line.trim());
	}
}

describe("background bash rows below the editor", () => {
	let host: FakeHost;
	let rows: JobBashRows;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.useFakeTimers({ now: START });
		host = new FakeHost();
		rows = new JobBashRows({ setWidget: host.setWidget, env: { NO_COLOR: "1" } });
	});
	afterEach(() => {
		rows.dispose();
		vi.useRealTimers();
	});

	it("shows a silent running job below the editor like a subagent row, ticking its spinner and elapsed time", async () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		expect(host.placement).toBe("belowEditor");
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_1 · bash_1 · running · 0s"]);

		await vi.advanceTimersByTimeAsync(65_000);
		// The spinner turns once a second, with the elapsed time.
		expect(host.lines()).toEqual(["⠴ sleep 90 # bash_1 · bash_1 · running · 1m 5s"]);
		expect(host.sets).toBe(1);
	});

	// A background server runs for hours; the rows must not keep an idle UI repainting faster than their text moves.
	it("repaints only when the elapsed text changes: once a second, then once a minute after the first hour", async () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		const before = host.renders;
		await vi.advanceTimersByTimeAsync(10_000);
		expect(host.renders - before).toBe(10);

		await vi.advanceTimersByTimeAsync(3_600_000 - 10_000);
		const hourMark = host.renders;
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(host.renders - hourMark).toBe(10);
		expect(host.lines()[0]).toMatch(/· running · 1h 10m$/);
		// An unchanged state from the engine repaints nothing.
		const settled = host.renders;
		rows.update(stateOf(bash("bash_1", "fallback")));
		expect(host.renders).toBe(settled);
	});

	it("leaves a job with a chart to the area above the editor and drops its row once the chart appears", () => {
		rows.update(stateOf(bash("bash_1", "pending"), bash("bash_2", "fallback")));
		expect(host.lines()).toEqual([
			"⠋ sleep 90 # bash_2 · bash_2 · running · 0s",
			"⠋ sleep 90 # bash_1 · bash_1 · running · 0s",
		]);
		rows.update(stateOf(bash("bash_1", "live", { view: CHART }), bash("bash_2", "fallback")));
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_2 · bash_2 · running · 0s"]);
		rows.update(stateOf(bash("bash_1", "done", { view: CHART, outcome: "success" }), bash("bash_2", "fallback")));
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_2 · bash_2 · running · 0s"]);
	});

	it("marks how a job ended: ✓ done, ✗ failed, ✗ killed, and drops the rows after the linger", async () => {
		rows.update(stateOf(bash("bash_1", "fallback"), bash("bash_2", "fallback"), bash("bash_3", "fallback")));
		await vi.advanceTimersByTimeAsync(8_000);
		rows.update(
			stateOf(
				bash("bash_1", "done", { outcome: "success" }),
				bash("bash_2", "done", { outcome: "failed" }),
				bash("bash_3", "skipped", { outcome: "killed" }),
			),
		);
		expect(host.lines()).toEqual([
			"✗ sleep 90 # bash_3 · bash_3 · killed · 8s",
			"✗ sleep 90 # bash_2 · bash_2 · failed · 8s",
			"✓ sleep 90 # bash_1 · bash_1 · done · 8s",
		]);

		await vi.advanceTimersByTimeAsync(DONE_LINGER_MS - 1);
		expect(host.lines()).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(host.component).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never shows a job that was already done when first seen", () => {
		rows.update(stateOf(bash("bash_1", "done", { outcome: "success" }), bash("bash_2", "fallback")));
		expect(host.lines()).toEqual(["⠋ sleep 90 # bash_2 · bash_2 · running · 0s"]);
	});

	it("colours the rows from the theme, and draws them plain under NO_COLOR", () => {
		const themedHost = new FakeHost();
		const themed = new JobBashRows({ setWidget: themedHost.setWidget, env: {} });
		const jobs = Array.from({ length: 6 }, (_, index) => bash(`bash_${index}`, "fallback"));
		themed.update(stateOf(...jobs));
		themed.update(stateOf(...jobs.slice(0, 5), bash("bash_5", "done", { outcome: "failed" })));
		const coloured = themedHost.component?.render(100) ?? [];
		expect(coloured.at(-1)).toContain(theme.fg("muted", "+1 more"));
		const failed = coloured.find((line) => plain(line).includes("failed"));
		expect(failed).toContain(theme.fg("error", "✗"));
		themed.dispose();

		rows.update(stateOf(...jobs));
		for (const line of host.component?.render(100) ?? []) expect(line).toBe(plain(line));
	});

	it("leaves task jobs alone, caps at five rows plus +N more, and fits the width", () => {
		const jobs = Array.from({ length: 7 }, (_, index) => bash(`bash_${index}`, "fallback"));
		const task: JobWidgetEntry = { ...bash("st_1", "fallback"), kind: "task" };
		rows.update(stateOf(task, ...jobs));
		const lines = host.lines(30);
		expect(lines).toHaveLength(6);
		expect(lines.at(-1)).toBe("+2 more");
		expect(lines.join("\n")).not.toContain("st_1");
		for (const line of host.component?.render(30) ?? []) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
	});

	it("stops ticking and removes the widget on dispose", () => {
		rows.update(stateOf(bash("bash_1", "fallback")));
		rows.dispose();
		expect(host.component).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});
