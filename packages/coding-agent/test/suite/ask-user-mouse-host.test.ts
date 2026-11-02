import { type Component, Container, setKeybindings, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { beforeAll, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { QuestionRequest } from "../../src/core/extensions/types.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { AskUserAsyncWidget } from "../../src/modes/interactive/components/ask-user-async-widget.ts";
import { AskUserQuestionComponent } from "../../src/modes/interactive/components/ask-user-question.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "../../src/modes/interactive/tui-renderer.ts";
import { createFakeInteractiveMode } from "./helpers/ask-user-async-fake-mode.ts";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});
function request(id: string): QuestionRequest {
	return {
		requestId: id,
		waitForAnswer: false,
		timeoutMs: 0,
		questions: [
			{
				id: "auth",
				header: "Auth",
				question: "Choose",
				multiSelect: false,
				options: [{ label: "OAuth" }, { label: "API key" }],
			},
		],
	};
}
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}
function setup(mouse = "whilePending") {
	const fake = createFakeInteractiveMode();
	Object.assign(fake.session.settingsManager, { getTerminalMouse: () => mouse });
	const terminal = new RecordingTerminal(120, 34);
	const renderer = new TuiMainScreen(terminal);
	const widgets = new Container();
	renderer.addChild(widgets);
	renderer.addChild(fake.editorContainer);
	let widget: AskUserAsyncWidget | undefined;
	const fields = Object.assign(fake, {
		renderer,
		ui: renderer as TUI,
		fullscreenLayoutRoot: new Container(),
		options: { tuiMode: "regular" },
		themeController: { rebindTui: vi.fn() },
		extensionTerminalInputSubscriptions: new Set(),
		setExtensionWidget: (_key: string, factory?: string[] | ((tui: TUI) => Component)) => {
			widgets.clear();
			widget = undefined;
			if (typeof factory !== "function") return;
			const component = factory(fields.ui);
			if (!(component instanceof AskUserAsyncWidget)) throw new Error("Unexpected widget");
			widget = component;
			widgets.addChild(component);
		},
	});
	Object.assign(fields, { ui: createInteractiveTuiReference(() => fields.renderer) });
	const acquire = vi.spyOn(renderer, "acquireMouseCapture");
	renderer.start();
	renderer.renderNow(true);
	return { fake, fields, renderer, terminal, acquire, widget: () => widget!, close: () => fields.renderer.stop() };
}
it("acquires one lease for two requests and releases only after both settle (#1645)", async () => {
	const h = setup();
	const a = new AbortController();
	const b = new AbortController();
	try {
		const one = h.fake.createExtensionUIContext().question!(request("one"), { signal: a.signal });
		const two = h.fake.createExtensionUIContext().question!(request("two"), { signal: b.signal });
		expect(h.acquire).toHaveBeenCalledExactlyOnceWith("pending-question");
		const release = vi.fn(h.acquire.mock.results[0].value as () => void);
		Object.assign(h.fake, { releaseMouseLease: release });
		a.abort();
		await one;
		expect(release).not.toHaveBeenCalled();
		b.abort();
		await two;
		expect(release).toHaveBeenCalledOnce();
	} finally {
		a.abort();
		b.abort();
		h.close();
	}
});
it("always acquires once on the host startup capture hook without a pending request", () => {
	const h = setup("always");
	try {
		const sync = Reflect.get(InteractiveMode.prototype, "syncQuestionMouseCapture") as (() => void) | undefined;
		expect(sync).toBeTypeOf("function");
		sync!.call(h.fake);
		sync!.call(h.fake);
		expect(h.acquire).toHaveBeenCalledExactlyOnceWith("always");
	} finally {
		h.close();
	}
});
it("off acquires nothing and suppresses fullscreen tracking bytes", async () => {
	const h = setup("off");
	const abort = new AbortController();
	try {
		const pending = h.fake.createExtensionUIContext().question!(request("off"), { signal: abort.signal });
		expect(h.acquire).not.toHaveBeenCalled();
		abort.abort();
		await pending;
		const terminal = new RecordingTerminal();
		const options = {
			tuiMode: "fullscreen" as const,
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			mouse: false,
		};
		const ui = createInteractiveTui(options);
		try {
			ui.start();
			ui.renderNow();
			expect(terminal.writes.join("")).not.toMatch(/\?100[026]h/);
		} finally {
			ui.stop();
		}
	} finally {
		abort.abort();
		h.close();
	}
});
it("reapplies exactly one lease to each replacement renderer while pending", async () => {
	const h = setup();
	const abort = new AbortController();
	const switchMode = (
		InteractiveMode.prototype as unknown as {
			switchTuiMode(mode: "regular" | "fullscreen", progress: boolean): boolean;
		}
	).switchTuiMode;
	try {
		const pending = h.fake.createExtensionUIContext().question!(request("switch"), { signal: abort.signal });
		for (const mode of ["fullscreen", "regular"] as const) {
			expect(switchMode.call(h.fake, mode, false)).toBe(true);
			expect(Reflect.get(h.fields.renderer, "mouseLeases").size).toBe(1);
		}
		abort.abort();
		await pending;
	} finally {
		abort.abort();
		h.close();
	}
});
it("writes the highlighted option before synchronous resolution on a widget click", async () => {
	const h = setup();
	const abort = new AbortController();
	try {
		const pending = h.fake.createExtensionUIContext().question!(request("click"), { signal: abort.signal });
		const states = Reflect.get(h.fake, "pendingQuestions") as Map<string, { finish: (response: unknown) => void }>;
		const state = states.get("click")!;
		const finish = state.finish;
		let resolved = false;
		let highlightedBeforeResolution = false;
		state.finish = (response) => {
			highlightedBeforeResolution = h.terminal.writes.some((line) => /OAuth.*✓/.test(line));
			resolved = true;
			finish(response);
		};
		h.renderer.renderNow(true);
		h.terminal.writes.length = 0;
		const widget = h.widget();
		const lines = widget.render(120);
		const y = lines.findIndex((line) => line.includes("OAuth"));
		const event = {
			type: "press" as const,
			button: "left" as const,
			x: 1,
			y,
			screenX: 1,
			screenY: y,
			width: 120,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		widget.handleMouse(event);
		widget.handleMouse({ ...event, type: "click" });
		expect(resolved).toBe(true);
		expect(highlightedBeforeResolution).toBe(true);
		expect(await pending).toMatchObject({ status: "answered", answers: { auth: { selected: ["OAuth"] } } });
	} finally {
		abort.abort();
		h.close();
	}
});
it("own-answer widget click mounts the focused inline input", () => {
	const h = setup();
	const abort = new AbortController();
	try {
		void h.fake.createExtensionUIContext().question!(request("own"), { signal: abort.signal });
		const widget = h.widget();
		const lines = widget.render(120);
		const y = lines.findIndex((line) => line.includes("own answer"));
		const plain = lines[y].replace(/\x1b\[[0-9;]*m/g, "");
		const x = plain.indexOf("own answer");
		widget.handleMouse({
			type: "click",
			button: "left",
			x,
			y,
			screenX: x,
			screenY: y,
			width: 120,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});
		const component = h.fake.editorContainer.children.find((child) => child instanceof AskUserQuestionComponent);
		expect(component?.render(120).join("\n")).toContain("Your answer (enter to save");
		expect(h.fields.ui.getFocusedComponent()).toBe(component);
	} finally {
		abort.abort();
		h.close();
	}
});
