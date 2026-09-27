import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { CustomEntryComponent } from "../../src/modes/interactive/components/custom-entry.ts";
import { CustomMessageComponent } from "../../src/modes/interactive/components/custom-message.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

function boundaryFixture() {
	const chat = new ExplorationTranscriptContainer({ tailBudget: 60, warmChunkSize: 100, requestRender() {} });
	const assistant = new AssistantMessageComponent(fauxAssistantMessage("settled answer"));
	chat.addChild(assistant);
	chat.render(80);
	const state = {
		chatContainer: chat,
		headerContainer: new Container(),
		loadedResourcesContainer: new Container(),
		pendingTools: new Map(),
		session: { isStreaming: false, isCompacting: false, isBashRunning: false, retryAttempt: 0 },
		workingRegionRevision: 0,
		workingRegionSnapshot: undefined,
		builtInHeader: new Text("original header", 0, 0),
		ui: { requestRender() {} },
	};
	state.headerContainer.addChild(state.builtInHeader);
	const read = (checkCustomContent = false) =>
		Reflect.get(InteractiveMode.prototype, "getWorkingRegionRevision").call(state, checkCustomContent) as
			| number
			| undefined;
	return { state, chat, assistant, read };
}

beforeEach(() => initTheme());

describe("native history working-region boundary", () => {
	it.each(["entry", "message"] as const)(
		"detects mutable custom %s output at its committed width without duplicate capture",
		(kind) => {
			const { chat, read } = boundaryFixture();
			let text = "before";
			const render = vi.fn((width: number) => [`${text}:${width}`]);
			const renderer = () => ({ render, invalidate() {} });
			const component =
				kind === "entry"
					? new CustomEntryComponent(
							{ type: "custom", id: "custom", parentId: null, timestamp: "now", customType: "fixture" },
							renderer,
						)
					: new CustomMessageComponent(
							{ role: "custom", customType: "fixture", content: "", display: true, timestamp: 0 },
							renderer,
						);
			chat.addChild(component);
			chat.render(80);
			render.mockClear();
			const initial = read();
			expect(render).not.toHaveBeenCalled();
			expect(read(true)).toBe(initial);
			expect(render).toHaveBeenLastCalledWith(80);
			// An export/measurement render is not a committed terminal frame.
			component.render(40);
			text = "change";
			expect(read(true)).toBeGreaterThan(initial!);
			expect(render).toHaveBeenLastCalledWith(80);
			chat.render(40);
			const updated = read();
			expect(read(true)).toBe(updated);
			expect(render).toHaveBeenLastCalledWith(40);
			chat.removeChild(component);
			render.mockClear();
			read(true);
			expect(render).not.toHaveBeenCalled();
			chat.render(40);
			read();
			render.mockClear();
			read(true);
			expect(render).not.toHaveBeenCalled();
			chat.dispose();
		},
	);

	it("keeps fixed OMO-style notice cards eligible without re-rendering the ordinary history", () => {
		const { chat, assistant, read } = boundaryFixture();
		const card = new CustomMessageComponent(
			{ role: "custom", customType: "task-complete", content: "", display: true, timestamp: 0 },
			() => {
				const notice = new Container();
				notice.addChild(new Text("Task complete", 0, 0));
				notice.addChild(new Text("Completed result", 0, 0));
				return notice;
			},
		);
		chat.addChild(card);
		chat.render(80);
		const initial = read();
		const ordinary = vi.spyOn(assistant, "render");
		expect(read(true)).toBe(initial);
		expect(read(true)).toBe(initial);
		expect(ordinary).not.toHaveBeenCalled();
		chat.invalidate();
		expect(read(true)).toBeGreaterThan(initial!);
		chat.dispose();
	});

	it("uses canonical rendering for custom headers and advances the revision when restoring the built-in header", () => {
		const { state, chat, read } = boundaryFixture();
		const replace = Reflect.get(InteractiveMode.prototype, "setExtensionHeader");
		const initial = read();
		replace.call(state, () => new Text("custom header", 0, 0));
		expect(read()).toBeUndefined();
		replace.call(state, () => new Text("another custom header", 0, 0));
		expect(read()).toBeUndefined();
		replace.call(state, undefined);
		expect(read()).toBeGreaterThan(initial!);
		chat.dispose();
	});

	it("keeps a stable document revision for input-only frames and advances for content or resource changes", () => {
		const { state, chat, assistant, read } = boundaryFixture();
		const initial = read();
		expect(initial).toBeTypeOf("number");
		expect(read()).toBe(initial);
		assistant.updateContent(fauxAssistantMessage("corrected settled answer"));
		const updated = read();
		expect(updated).toBeGreaterThan(initial!);
		chat.render(80);
		expect(read()).toBe(updated);
		state.loadedResourcesContainer.addChild(new Text("loaded resource", 0, 0));
		const resource = read();
		expect(resource).toBeGreaterThan(updated!);
		chat.children.splice(0, 1, new Text("replacement", 0, 0));
		chat.markProjectionDirty(0);
		expect(read()).toBeGreaterThan(resource!);
		chat.dispose();
	});

	it("advances the document revision after explicit invalidation without assistant or tool cards", () => {
		const { chat, read } = boundaryFixture();
		chat.clear();
		chat.addChild(new Text("custom-only document", 0, 0));
		chat.render(80);
		const initial = read();
		chat.invalidate();
		expect(read()).toBeGreaterThan(initial!);
		chat.dispose();
	});

	it.each(["isStreaming", "isCompacting", "isBashRunning"] as const)(
		"does not adopt mutable document state during %s",
		(flag) => {
			const { state, chat, read } = boundaryFixture();
			state.session[flag] = true;
			expect(read()).toBeUndefined();
			state.session[flag] = false;
			expect(read()).toBeTypeOf("number");
			chat.dispose();
		},
	);

	it("keeps retry waits and pending tool results on the canonical renderer", () => {
		const { state, chat, read } = boundaryFixture();
		state.session.retryAttempt = 1;
		expect(read()).toBeUndefined();
		state.session.retryAttempt = 0;
		state.pendingTools.set("pending", {});
		expect(read()).toBeUndefined();
		state.pendingTools.clear();
		expect(read()).toBeTypeOf("number");
		chat.dispose();
	});
});
