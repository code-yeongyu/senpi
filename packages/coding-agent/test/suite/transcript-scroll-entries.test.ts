import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationGroup } from "../../src/modes/interactive/components/exploration-group.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { UserMessageComponent } from "../../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const options = { tailBudget: 60, warmChunkSize: 100, requestRender() {} };
const ui = { requestRender() {} } as TUI;

function read(id: string): ToolExecutionComponent {
	const tool = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, undefined, ui, process.cwd());
	tool.updateResult({ content: [{ type: "text", text: `result-${id}` }], isError: false });
	return tool;
}

beforeEach(() => initTheme());

describe("indexed transcript source", () => {
	it("exposes the projection and prefix without rendering or revisiting an unchanged history", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const first = read("first");
		transcript.addChild(first);
		transcript.addChild(new Text("boundary", 0, 0));
		const assistant = new AssistantMessageComponent(fauxAssistantMessage("answer"));
		transcript.addChild(assistant);
		const header = new Container();
		const resources = new Container();
		const source = transcript.createScrollEntrySource([header, resources]);
		const render = vi.spyOn(first, "render");
		expect(source.length).toBe(5);
		expect(source.get(0).component).toBe(header);
		expect(source.get(1).component).toBe(resources);
		expect(source.get(2)).toMatchObject({ key: first, sourceIndex: 2 });
		expect(source.get(2).component).toBeInstanceOf(ExplorationGroup);
		const snapshot = vi.spyOn(first, "presentationSnapshot", "get");
		const firstRevision = source.get(4).revision;
		assistant.updateContent(fauxAssistantMessage("answer grows"));
		expect(source.get(4).revision).toBeGreaterThan(firstRevision!);
		expect(source.length).toBe(5);
		expect(source.indexOf(first)).toBe(2);
		expect(snapshot).not.toHaveBeenCalled();
		expect(render).not.toHaveBeenCalled();
		transcript.dispose();
	});

	it("resolves original source identities through group splits and deleted-anchor fallback", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const first = read("first");
		const assistant = new AssistantMessageComponent(fauxAssistantMessage(""), true);
		const last = read("last");
		transcript.addChild(first);
		transcript.addChild(assistant);
		transcript.addChild(last);
		const source = transcript.createScrollEntrySource();
		expect(source.length).toBe(1);
		expect(source.indexOf(last)).toBe(0);
		assistant.updateContent(fauxAssistantMessage("visible answer"));
		expect(source.length).toBe(3);
		expect(source.indexOf(last)).toBe(2);
		transcript.removeChild(assistant);
		expect(source.indexOf(assistant)).toBeUndefined();
		expect(source.resolve(assistant, 1)).toBe(0);
		transcript.clear();
		expect(source.resolve(first, 0)).toBeUndefined();
		transcript.dispose();
	});

	it("leaves unobserved mutable cards and groups unversioned", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		transcript.addChild(new UserMessageComponent("question"));
		transcript.addChild(read("group"));
		transcript.addChild(new Text("custom", 0, 0));
		const source = transcript.createScrollEntrySource();
		expect(source.get(0)).toMatchObject({ prompt: true });
		expect(source.get(0).revision).toBeUndefined();
		expect(source.get(1).revision).toBeUndefined();
		expect(source.get(2).revision).toBeUndefined();
		transcript.dispose();
	});

	it("does not let indexed readers replace the original transcript listener or disposal owner", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const assistant = new AssistantMessageComponent(fauxAssistantMessage("before"));
		const dispose = vi.spyOn(assistant, "dispose");
		transcript.addChild(assistant);
		const first = transcript.createScrollEntrySource();
		const second = transcript.createScrollEntrySource([new Container()]);
		const version = first.version;
		second.get(1);
		assistant.updateContent(fauxAssistantMessage("after"));
		expect(first.version).toBeGreaterThan(version);
		expect(second.version).toBe(first.version);
		expect(dispose).not.toHaveBeenCalled();
		transcript.dispose();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("invalidates a cached tool entry when its spinner is stopped directly", () => {
		vi.useFakeTimers();
		const transcript = new ExplorationTranscriptContainer(options);
		try {
			const tool = new ToolExecutionComponent(
				"write",
				"write",
				{},
				{},
				{ renderCall: (_args, _theme, context) => new Text(`frame:${context.spinnerFrame ?? "stopped"}`, 0, 0) },
				ui,
				process.cwd(),
			);
			transcript.addChild(tool);
			const source = transcript.createScrollEntrySource();
			source.get(0);
			vi.advanceTimersByTime(80);
			const animated = tool.render(80);
			const revision = source.get(0).revision;
			const version = source.version;
			tool.stopAnimation();
			expect(source.get(0).revision).toBeGreaterThan(revision!);
			expect(source.changedSince?.(version)).toBe(0);
			expect(tool.render(80)).not.toEqual(animated);
			expect(tool.render(80).join("\n")).toContain("frame:stopped");
		} finally {
			transcript.dispose();
			vi.useRealTimers();
		}
	});
});

describe("transcript selection change journal", () => {
	it("distinguishes appends after selection from mutations in its middle", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const first = new AssistantMessageComponent(fauxAssistantMessage("first"));
		const middle = new AssistantMessageComponent(fauxAssistantMessage("middle"));
		transcript.addChild(first);
		transcript.addChild(middle);
		const source = transcript.createScrollEntrySource([new Container(), new Container()]);
		const beforeAppend = source.version;
		const middleRevision = source.get(3).revision;
		transcript.addChild(new Text("appended", 0, 0));
		expect(source.changedSince?.(beforeAppend)).toBe(4);
		expect(source.get(3).revision).toBe(middleRevision);
		const beforeEdit = source.version;
		middle.updateContent(fauxAssistantMessage("changed middle"));
		expect(source.changedSince?.(beforeEdit)).toBe(3);
		expect(source.changedSince?.(beforeAppend)).toBe(3);
		expect(source.changedSince?.(source.version)).toBe(Number.POSITIVE_INFINITY);
		transcript.dispose();
	});

	it("invalidates a detached card before it is reinserted after unobserved changes", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const assistant = new AssistantMessageComponent(fauxAssistantMessage("before"));
		transcript.addChild(assistant);
		const source = transcript.createScrollEntrySource();
		const revision = source.get(0).revision;
		transcript.detachChild(assistant);
		expect(source.length).toBe(0);
		assistant.updateContent(fauxAssistantMessage("changed while detached"));
		transcript.addChild(assistant);
		expect(source.get(0).revision).toBeGreaterThan(revision!);
		const reinsertedRevision = source.get(0).revision;
		transcript.detachAll();
		assistant.updateContent(fauxAssistantMessage("changed after detachAll"));
		transcript.addChild(assistant);
		expect(source.get(0).revision).toBeGreaterThan(reinsertedRevision!);
		transcript.dispose();
	});

	it("reports an extended or mutated exploration group at its first source member", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const first = read("first");
		transcript.addChild(new Text("earlier", 0, 0));
		transcript.addChild(first);
		const source = transcript.createScrollEntrySource();
		const beforeAppend = source.version;
		const last = read("last");
		transcript.addChild(last);
		expect(source.changedSince?.(beforeAppend)).toBe(1);
		const beforeEdit = source.version;
		last.updateArgs({ path: "changed.ts" });
		expect(source.changedSince?.(beforeEdit)).toBe(1);
		transcript.dispose();
	});

	it("invalidates from the source start on clear, prefix change and global display change", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		transcript.addChild(new AssistantMessageComponent(fauxAssistantMessage("answer")));
		const source = transcript.createScrollEntrySource([new Container(), new Container()]);
		const beforePrefix = source.version;
		transcript.markScrollEntryPrefixChanged();
		expect(source.changedSince?.(beforePrefix)).toBe(0);
		const beforeDisplay = source.version;
		const display = source.displayRevision;
		transcript.invalidate();
		expect(source.displayRevision).toBeGreaterThan(display);
		expect(source.changedSince?.(beforeDisplay)).toBe(0);
		const beforeClear = source.version;
		transcript.clear();
		expect(source.changedSince?.(beforeClear)).toBe(2);
		transcript.dispose();
	});

	it("fails closed for invalid versions and changes older than the bounded journal", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const assistant = new AssistantMessageComponent(fauxAssistantMessage("initial"));
		transcript.addChild(assistant);
		const source = transcript.createScrollEntrySource();
		const initial = source.version;
		for (let index = 0; index < 64; index++) assistant.updateContent(fauxAssistantMessage(`update ${index}`));
		expect(source.changedSince?.(initial)).toBe(0);
		assistant.updateContent(fauxAssistantMessage("overflow"));
		expect(source.changedSince?.(initial)).toBeUndefined();
		expect(source.changedSince?.(initial + 1)).toBe(0);
		expect(source.changedSince?.(source.version + 1)).toBeUndefined();
		expect(source.changedSince?.(-1)).toBeUndefined();
		expect(source.changedSince?.(Number.NaN)).toBeUndefined();
		transcript.dispose();
	});
});
