import { Loader, setCapabilities, setKeybindings } from "@earendil-works/pi-tui";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { explorationSurface } from "./exploration-surface-harness.ts";

beforeAll(() => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
afterEach(() => vi.useRealTimers());

it("updates a long-session working shimmer between its one-second content ticks", async () => {
	const surface = await explorationSurface();
	vi.useFakeTimers({ now: 0 });
	for (let index = 0; index < 2500; index++) {
		surface.harness.session.sessionManager.appendCustomEntry("animation-fixture", { index });
	}
	const ui = Reflect.get(surface.mode, "ui");
	const getOptions = Reflect.get(surface.mode, "getWorkingIndicatorOptions");
	if (typeof getOptions !== "function") throw new Error("Missing status options method");
	const options = getOptions.call(surface.mode);
	const loader = new Loader(
		ui,
		(s) => s,
		(s) => s,
		"Running read",
		options,
	);
	try {
		const before = loader.render(140).join("");
		vi.advanceTimersByTime(480);
		expect(loader.render(140).join("")).not.toBe(before);
	} finally {
		loader.dispose();
		surface.cleanup();
	}
});

it("advances an exploring read without a status loader or tool output", async () => {
	const surface = await explorationSurface();
	vi.useFakeTimers({ now: 0 });
	const ui = Reflect.get(surface.mode, "ui");
	const request = vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	try {
		await surface.event({
			type: "tool_execution_start",
			toolCallId: "read-regression",
			toolName: "read",
			args: { path: "fixture.ts" },
		});
		const before = surface.text();
		request.mockClear();
		vi.advanceTimersByTime(80);
		expect(request).toHaveBeenCalledOnce();
		expect(surface.text()).not.toBe(before);
	} finally {
		surface.cleanup();
	}
});

it("keeps requesting frames on the runtime clock and stops after a pending read settles", async () => {
	const surface = await explorationSurface();
	const ui = Reflect.get(surface.mode, "ui");
	const times: number[] = [];
	const request = vi.spyOn(ui, "requestRender").mockImplementation(() => {
		times.push(performance.now());
		surface.text();
	});
	try {
		await surface.event({
			type: "tool_execution_start",
			toolCallId: "runtime-clock",
			toolName: "read",
			args: { path: "fixture.ts" },
		});
		surface.text();
		times.length = 0;
		await delay(1600);
		const gaps = times
			.slice(1)
			.map((time, index) => time - times[index])
			.sort((a, b) => a - b);
		expect(times.length).toBeGreaterThanOrEqual(12);
		expect(gaps[Math.floor(gaps.length * 0.95)]).toBeLessThanOrEqual(150);
		await surface.event({
			type: "tool_execution_end",
			toolCallId: "runtime-clock",
			toolName: "read",
			result: { content: [{ type: "text", text: "fixture result" }] },
			isError: false,
		});
		surface.text();
		request.mockClear();
		await delay(240);
		expect(request).not.toHaveBeenCalled();
	} finally {
		surface.cleanup();
	}
});
