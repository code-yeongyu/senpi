import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DONE_LINGER_MS,
	JOB_WIDGET_TUI_KEY,
	JobWidgetArea,
} from "../../src/core/extensions/builtin/job-widgets/tui-widget.ts";
import type { JobWidgetEntry, JobWidgetState } from "../../src/core/extensions/builtin/job-widgets/view-types.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";

type Factory = (tui: TUI, theme: Theme) => Component;

function entry(id: string, state: JobWidgetEntry["state"], headline = "1"): JobWidgetEntry {
	if (state === "skipped") return { id, kind: "bash", state, updatedAtMs: 0 };
	return {
		id,
		kind: "bash",
		state,
		updatedAtMs: 0,
		view: { title: `job ${id}`, headline: { text: headline, label: "done" }, blocks: [], lines: 3 },
	};
}

function stateOf(...jobs: JobWidgetEntry[]): JobWidgetState {
	return { v: 1, sessionId: "s1", jobs };
}

class FakeWidgetHost {
	component: Component | undefined;
	sets = 0;
	renders = 0;
	readonly tui = { requestRender: () => this.renders++ } as unknown as TUI;

	setWidget = (key: string, content: Factory | undefined): void => {
		expect(key).toBe(JOB_WIDGET_TUI_KEY);
		this.sets += 1;
		this.component = content?.(this.tui, theme);
	};

	lines(width = 80): string[] {
		return (this.component?.render(width) ?? []).map((line) => line.trim());
	}
}

describe("the TUI job widget area", () => {
	let host: FakeWidgetHost;
	let area: JobWidgetArea;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.useFakeTimers();
		host = new FakeWidgetHost();
		area = new JobWidgetArea({ setWidget: host.setWidget, env: { NO_COLOR: "1" } });
	});
	afterEach(() => {
		area.dispose();
		vi.useRealTimers();
	});

	it("lists at most three jobs, newest first, then +N more", () => {
		area.update(
			stateOf(
				entry("bash_1", "live"),
				entry("bash_2", "live"),
				entry("bash_3", "pending"),
				entry("bash_4", "live"),
				entry("bash_5", "fallback"),
			),
		);
		expect(host.lines().map((line) => line.split("  ")[0])).toEqual(["bash_5", "bash_4", "bash_3", "+2 more"]);
	});

	it("shows nothing for skipped jobs, nor while only fallback rows remain", () => {
		area.update(stateOf(entry("bash_1", "skipped"), entry("bash_2", "fallback")));
		expect(host.component).toBeUndefined();
		area.update(stateOf(entry("bash_1", "skipped"), entry("bash_2", "fallback"), entry("bash_3", "live")));
		expect(host.lines().map((line) => line.split("  ")[0])).toEqual(["bash_3", "bash_2"]);
	});

	it("keeps a finished job for ten seconds after it is first seen done, then removes the area", () => {
		area.update(stateOf(entry("bash_1", "live")));
		area.update(stateOf(entry("bash_1", "done", "7")));
		expect(host.lines()).toEqual([expect.stringContaining("done 7")]);

		vi.advanceTimersByTime(DONE_LINGER_MS - 1);
		area.update(stateOf(entry("bash_1", "done", "7")));
		expect(host.component).toBeDefined();

		vi.advanceTimersByTime(1);
		expect(host.component).toBeUndefined();
	});

	it("shows nothing after a reload re-sends a job that had already finished, yet lingers one that finishes later", () => {
		area.update(stateOf(entry("bash_1", "live")));
		area.update(stateOf(entry("bash_1", "done", "7")));
		expect(host.lines()).toEqual([expect.stringContaining("done 7")]);

		// A reload (or a config-reload) disposes the area and the next generation builds a new one; the
		// re-bound registry then re-sends every job it still holds, finished ones included.
		area.dispose();
		const reloaded = new FakeWidgetHost();
		area = new JobWidgetArea({ setWidget: reloaded.setWidget, env: { NO_COLOR: "1" } });
		area.update(stateOf(entry("bash_1", "done", "7")));
		expect(reloaded.component).toBeUndefined();
		expect(reloaded.sets).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		area.update(stateOf(entry("bash_1", "done", "7"), entry("bash_2", "live")));
		area.update(stateOf(entry("bash_1", "done", "7"), entry("bash_2", "done", "9")));
		expect(reloaded.lines()).toEqual([expect.stringContaining("done 9")]);
		vi.advanceTimersByTime(DONE_LINGER_MS);
		expect(reloaded.component).toBeUndefined();
	});

	it("updates the same component on a change and does nothing for an unchanged state", () => {
		area.update(stateOf(entry("bash_1", "live", "1")));
		const first = host.component;
		area.update(stateOf({ ...entry("bash_1", "live", "1"), updatedAtMs: 99 }));
		expect(host.renders).toBe(0);
		area.update(stateOf(entry("bash_1", "live", "2")));
		expect(host.component).toBe(first);
		expect(host.sets).toBe(1);
		expect(host.renders).toBe(1);
		expect(host.lines()[0]).toContain("done 2");
	});

	it("never draws a line wider than the terminal", () => {
		const long = { ...entry("bash_1", "live"), view: { title: "x".repeat(300), blocks: [] } };
		area.update(stateOf(long));
		for (const width of [40, 80, 120]) {
			for (const line of host.component?.render(width) ?? []) {
				expect(line).not.toMatch(/\x1b/);
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("keeps the +N more row within the width at every narrow width", () => {
		const jobs = [1, 2, 3, 4, 5].map((n) => entry(`bash_${n}`, "live"));
		const themed = new FakeWidgetHost();
		const themedArea = new JobWidgetArea({ setWidget: themed.setWidget, env: {} });
		area.update(stateOf(...jobs));
		themedArea.update(stateOf(...jobs));
		try {
			for (const width of [5, 6, 7, 8, 9, 10, 11, 12]) {
				for (const component of [host.component, themed.component]) {
					const lines = component?.render(width) ?? [];
					// PI_TUI_STRICT_RENDER=1 throws on the first line whose visible width exceeds the terminal.
					for (const line of lines)
						expect(visibleWidth(line), `${JSON.stringify(line)} at ${width}`).toBeLessThanOrEqual(width);
					expect(
						lines
							.at(-1)
							?.replace(/\x1b\[[0-9;]*m/g, "")
							.trim(),
					).toMatch(/^\+2/);
				}
				expect(host.component?.render(width).join("")).not.toMatch(/\x1b/);
			}
			expect(host.component?.render(12).at(-1)).toBe(" +2 more");
		} finally {
			themedArea.dispose();
		}
	});

	it("clears the area and stops its timer when disposed", () => {
		area.update(stateOf(entry("bash_1", "live")));
		area.update(stateOf(entry("bash_1", "done")));
		expect(vi.getTimerCount()).toBe(1);
		area.dispose();
		expect(host.component).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});
