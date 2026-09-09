import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Theme } from "../../src/modes/interactive/theme/theme.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createLiveComponentRenderer } from "../../src/modes/rpc/widget-line-renderer.ts";

// The live component renderer is what lets a shared RPC host render extension
// component factories (setWidget/setHeader/setFooter closures) into plain text
// lines that cross the wire, instead of dropping them or warning that the
// classic TUI is required.

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

type Factory = (tui: TUI, thm: Theme) => Component & { dispose?(): void };

function widthEchoFactory(): Factory {
	return (_tui, _thm) => ({ invalidate() {}, render: (width: number) => [`w:${width}`] });
}

describe("createLiveComponentRenderer", () => {
	it("renders the component synchronously at the provided width and emits the lines", () => {
		const emitted: string[][] = [];
		const renderer = createLiveComponentRenderer({
			factory: widthEchoFactory(),
			getWidth: () => 72,
			emit: (lines) => emitted.push(lines),
		});
		expect(renderer).toBeDefined();
		expect(emitted).toEqual([["w:72"]]);
	});

	it("re-renders and emits on requestRender, coalescing bursts into one emission", () => {
		const emitted: string[][] = [];
		let value = "first";
		let capturedTui: TUI | undefined;
		const renderer = createLiveComponentRenderer({
			factory: (tui) => {
				capturedTui = tui;
				return { invalidate() {}, render: () => [value] };
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
		});
		expect(renderer).toBeDefined();
		expect(emitted).toEqual([["first"]]);

		value = "second";
		capturedTui?.requestRender();
		capturedTui?.requestRender();
		capturedTui?.requestRender();
		// Nothing emitted until the coalescing window elapses.
		expect(emitted).toHaveLength(1);
		vi.runAllTimers();
		expect(emitted).toEqual([["first"], ["second"]]);
	});

	it("skips emissions when the rendered output is unchanged", () => {
		const emitted: string[][] = [];
		let capturedTui: TUI | undefined;
		createLiveComponentRenderer({
			factory: (tui) => {
				capturedTui = tui;
				return { invalidate() {}, render: () => ["static"] };
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
		});
		capturedTui?.requestRender();
		vi.runAllTimers();
		expect(emitted).toEqual([["static"]]);
	});

	it("rerender() re-renders immediately with the current width", () => {
		const emitted: string[][] = [];
		let width = 80;
		const renderer = createLiveComponentRenderer({
			factory: widthEchoFactory(),
			getWidth: () => width,
			emit: (lines) => emitted.push(lines),
		});
		width = 40;
		renderer?.rerender();
		expect(emitted).toEqual([["w:80"], ["w:40"]]);
	});

	it("dispose() disposes the component and stops all further emissions", () => {
		const emitted: string[][] = [];
		const dispose = vi.fn();
		let capturedTui: TUI | undefined;
		const renderer = createLiveComponentRenderer({
			factory: (tui) => {
				capturedTui = tui;
				return { invalidate() {}, render: () => ["live"], dispose };
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
		});
		renderer?.dispose();
		expect(dispose).toHaveBeenCalledTimes(1);
		capturedTui?.requestRender();
		vi.runAllTimers();
		renderer?.rerender();
		expect(emitted).toEqual([["live"]]);
	});

	it("reports a factory fault instead of throwing and creates no renderer", () => {
		const emitted: string[][] = [];
		const faults: unknown[] = [];
		const renderer = createLiveComponentRenderer({
			factory: () => {
				throw new Error("factory boom");
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
			onRenderFault: (error) => faults.push(error),
		});
		expect(renderer).toBeUndefined();
		expect(emitted).toEqual([]);
		expect(faults).toHaveLength(1);
		expect((faults[0] as Error).message).toBe("factory boom");
	});

	it("disposes after a render fault that scheduled another render", () => {
		const emitted: string[][] = [];
		let capturedTui: TUI | undefined;
		const renderer = createLiveComponentRenderer({
			factory: (tui) => {
				capturedTui = tui;
				tui.requestRender();
				throw new Error("factory boom");
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
		});
		expect(renderer).toBeUndefined();
		expect(() => vi.runAllTimers()).not.toThrow();
		expect(capturedTui).toBeDefined();
		expect(emitted).toEqual([]);
		renderer?.rerender();
		expect(emitted).toEqual([]);
	});

	it("reports a later render fault without emitting and keeps the renderer alive", () => {
		const emitted: string[][] = [];
		const faults: unknown[] = [];
		let broken = false;
		let capturedTui: TUI | undefined;
		createLiveComponentRenderer({
			factory: (tui) => {
				capturedTui = tui;
				return {
					invalidate() {},
					render: () => {
						if (broken) throw new Error("render boom");
						return ["ok"];
					},
				};
			},
			getWidth: () => 80,
			emit: (lines) => emitted.push(lines),
			onRenderFault: (error) => faults.push(error),
		});
		broken = true;
		capturedTui?.requestRender();
		vi.runAllTimers();
		expect(emitted).toEqual([["ok"]]);
		expect(faults).toHaveLength(1);
		// Recovery: the component renders again once the fault clears.
		broken = false;
		capturedTui?.requestRender();
		vi.runAllTimers();
		expect(emitted).toEqual([["ok"], ["ok"]]);
	});

	it("passes the real theme through to the factory", () => {
		let receivedTheme: Theme | undefined;
		createLiveComponentRenderer({
			factory: (_tui, thm) => {
				receivedTheme = thm;
				return { invalidate() {}, render: () => [""] };
			},
			getWidth: () => 80,
			emit: () => {},
		});
		expect(receivedTheme).toBe(theme);
	});
});
