import { Loader, Text, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import { AnimatedStatusText } from "../../src/modes/interactive/components/animated-status-text.ts";
import { AnimationFrame } from "../../src/modes/interactive/components/animation-frame.ts";
import { ExplorationGroup } from "../../src/modes/interactive/components/exploration-group.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { largeSessionWorkingStatusInterval } from "../../src/modes/interactive/working-status.ts";
import { workingStatusAnimation } from "../../src/modes/interactive/working-status-animation.ts";
import { explorationSurface } from "./exploration-surface-harness.ts";

beforeAll(() => initTheme("dark"));
afterEach(() => vi.useRealTimers());

function uiFixture() {
	const ui = new TUI(new VirtualTerminal(120, 40));
	const request = vi.spyOn(ui, "requestRender").mockImplementation(() => {});
	return { ui, request };
}

describe("presentation cadence independent of content cadence", () => {
	it.each([999, 1000, 2500])("animates between content updates with %i persisted entries", (entries) => {
		vi.useFakeTimers({ now: 0 });
		const { ui, request } = uiFixture();
		const getElapsed = vi.fn(() => Math.floor(Date.now() / 1000));
		const formatter = workingStatusAnimation(
			getElapsed,
			"esc",
			{
				base: (s) => s,
				glow: (s) => s,
				highlight: (s) => s,
				shimmer: (s, amount) => `${s}:${amount.toFixed(3)}`,
				suffix: (s) => s,
			},
			largeSessionWorkingStatusInterval(entries, 32, 1000),
		);
		const loader = new Loader(
			ui,
			(s) => s,
			(s) => s,
			"Running read",
			{ frames: ["•"], ...formatter },
		);
		try {
			const first = loader.render(120).join("");
			const callsAtStart = getElapsed.mock.calls.length;
			vi.advanceTimersByTime(480);
			expect(loader.render(120).join("")).not.toBe(first);
			expect(request.mock.calls.length).toBeGreaterThanOrEqual(3);
			if (entries >= 1000) expect(getElapsed.mock.calls.length).toBe(callsAtStart);
			vi.advanceTimersByTime(560);
			expect(loader.render(120).join("")).toContain("(1s");
		} finally {
			loader.dispose();
			expect(vi.getTimerCount()).toBe(0);
			ui.stop();
		}
	});

	it("does not start a presentation timer for a static extension indicator", () => {
		vi.useFakeTimers();
		const { ui } = uiFixture();
		const loader = new Loader(
			ui,
			(s) => s,
			(s) => s,
			"Static",
			{ frames: ["•"] },
		);
		expect(vi.getTimerCount()).toBe(0);
		loader.dispose();
		ui.stop();
	});

	it("keeps decorative frames on their own slow clock", () => {
		vi.useFakeTimers({ now: 0 });
		const { ui } = uiFixture();
		const loader = new Loader(
			ui,
			(s) => s,
			(s) => s,
			"Status",
			{
				frames: ["A", "B"],
				intervalMs: 1000,
				messageIntervalMs: 1000,
				presentationIntervalMs: 80,
				presentationFormatter: (s, time) => `${s}:${time}`,
			},
		);
		try {
			vi.advanceTimersByTime(400);
			expect(loader.render(120).join("")).toContain("A Status:400");
			vi.advanceTimersByTime(600);
			expect(loader.render(120).join("")).toContain("B Status:1000");
		} finally {
			loader.dispose();
			ui.stop();
		}
	});

	it("drops the previous presentation timer when options change", () => {
		vi.useFakeTimers();
		const { ui, request } = uiFixture();
		const loader = new Loader(
			ui,
			(s) => s,
			(s) => s,
			"Status",
			{
				frames: [],
				presentationIntervalMs: 80,
				presentationFormatter: (s, time) => `${s}:${time}`,
			},
		);
		loader.setIndicator({ frames: ["•"] });
		const lastCalls = request.mock.calls.length;
		vi.advanceTimersByTime(1000);
		expect(request.mock.calls.length).toBe(lastCalls);
		expect(vi.getTimerCount()).toBe(0);
		loader.dispose();
		ui.stop();
	});
});

describe("paint-driven animation lifetime", () => {
	it("schedules once per paint and stops when the component is no longer painted", () => {
		vi.useFakeTimers();
		const request = vi.fn();
		const animation = new AnimationFrame(request);
		animation.schedule();
		animation.schedule();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(80);
		expect(request).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1000);
		expect(request).toHaveBeenCalledTimes(1);
		animation.schedule();
		animation.cancel();
		vi.advanceTimersByTime(80);
		expect(request).toHaveBeenCalledTimes(1);
		animation.dispose();
		animation.schedule();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("paints animated status text without an always-running timer", () => {
		vi.useFakeTimers({ now: 0 });
		const request = vi.fn();
		const component = new AnimatedStatusText(request, () => `Hook:${Date.now()}`);
		expect(vi.getTimerCount()).toBe(0);
		expect(component.render(40).join("")).toContain("Hook:0");
		vi.advanceTimersByTime(80);
		expect(request).toHaveBeenCalledOnce();
		expect(component.render(40).join("")).toContain("Hook:80");
		component.invalidate();
		component.dispose();
		vi.advanceTimersByTime(1000);
		expect(request).toHaveBeenCalledOnce();
	});
});

describe("exploration requests frames without working status or tool output", () => {
	it("stops a directly disposed group and retains expanded mouse routing", () => {
		vi.useFakeTimers();
		const { ui, request } = uiFixture();
		const card = new ToolExecutionComponent(
			"read",
			"direct",
			{ path: "fixture.ts" },
			{},
			undefined,
			ui,
			process.cwd(),
		);
		card.setArgsComplete();
		const group = new ExplorationGroup(() => request());
		try {
			group.setMembers(
				[new Text("body")],
				[{ component: card, call: { action: "Read", label: "fixture.ts", pending: true, failed: false } }],
				["rule-a"],
			);
			group.render(120);
			const event = { type: "press", button: "right", x: 1, y: 1, width: 120, height: 8, screenX: 1, screenY: 1 };
			expect(Reflect.apply(group.handleMouse, group, [event])).toBeUndefined();
			card.setExpanded(true);
			expect(Reflect.apply(group.handleMouse, group, [{ ...event, y: 3, screenY: 3 }])).toBeUndefined();
			card.setExpanded(false);
			group.setMembers(group.children, group.calls, ["rule-b"]);
			expect(group.render(120).join("")).toContain("Applied");
			group.dispose();
			request.mockClear();
			vi.advanceTimersByTime(1000);
			expect(request).not.toHaveBeenCalled();
		} finally {
			group.dispose();
			card.dispose();
			ui.stop();
		}
	});

	it("preserves status presentation after a theme/cache invalidation", async () => {
		const surface = await explorationSurface();
		try {
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "first",
				toolName: "read",
				args: { path: "first.ts" },
			});
			const before = surface.text();
			surface.chat.invalidate();
			expect(surface.text()).toContain("first.ts");
			expect(before).toContain("first.ts");
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "second",
				toolName: "read",
				args: { path: "second.ts" },
			});
			expect(surface.text()).toContain("second.ts");
		} finally {
			surface.cleanup();
		}
	});
	it("keeps a pending read moving without a working loader", async () => {
		const surface = await explorationSurface();
		vi.useFakeTimers({ now: 0 });
		const request = vi.spyOn(Reflect.get(surface.mode, "ui"), "requestRender").mockImplementation(() => {});
		try {
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "pending-read",
				toolName: "read",
				args: { path: "fixture.ts" },
			});
			const first = surface.text();
			request.mockClear();
			vi.advanceTimersByTime(80);
			expect(request).toHaveBeenCalledOnce();
			expect(surface.text()).not.toBe(first);
			await surface.event({
				type: "tool_execution_end",
				toolCallId: "pending-read",
				toolName: "read",
				result: { content: [{ type: "text", text: "done" }] },
				isError: false,
			});
			surface.text();
			request.mockClear();
			vi.advanceTimersByTime(1000);
			expect(request).not.toHaveBeenCalled();
		} finally {
			surface.cleanup();
		}
	});

	it.each(["clear", "detachAll", "dispose"])("stops pending group timers on transcript %s", async (method) => {
		const surface = await explorationSurface();
		vi.useFakeTimers();
		const request = vi.spyOn(Reflect.get(surface.mode, "ui"), "requestRender").mockImplementation(() => {});
		try {
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "pending",
				toolName: "read",
				args: { path: "fixture.ts" },
			});
			surface.text();
			expect(vi.getTimerCount()).toBeGreaterThan(0);
			Reflect.get(surface.chat, method).call(surface.chat);
			request.mockClear();
			vi.advanceTimersByTime(1000);
			expect(request).not.toHaveBeenCalled();
		} finally {
			surface.cleanup();
		}
	});

	it("cancels a projected group when its original card is removed", async () => {
		const surface = await explorationSurface();
		vi.useFakeTimers();
		const request = vi.spyOn(Reflect.get(surface.mode, "ui"), "requestRender").mockImplementation(() => {});
		try {
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "pending",
				toolName: "read",
				args: { path: "fixture.ts" },
			});
			surface.text();
			const card = surface.chat.children.at(-1);
			if (!card) throw new Error("Missing pending card");
			surface.chat.detachChild(card);
			surface.text();
			request.mockClear();
			vi.advanceTimersByTime(1000);
			expect(request).not.toHaveBeenCalled();
			card.dispose?.();
		} finally {
			surface.cleanup();
		}
	});
});
