import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantMessageComponent } from "../../src/modes/interactive/components/assistant-message.ts";
import { ExplorationTranscriptContainer } from "../../src/modes/interactive/components/exploration-transcript-container.ts";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const options = { tailBudget: 60, warmChunkSize: 100, requestRender() {} };
const ui = { requestRender() {} } as TUI;

function read(id: string): ToolExecutionComponent {
	const tool = new ToolExecutionComponent("read", id, { path: `${id}.ts` }, {}, undefined, ui, process.cwd());
	tool.updateResult({ content: [{ type: "text", text: `result-${id}` }], isError: false });
	return tool;
}

beforeEach(() => initTheme());

describe("cached transcript projection", () => {
	it("does not reclassify an unchanged prefix on resize or a later tool update", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const first = read("first");
		const last = read("last");
		transcript.addChild(first);
		transcript.addChild(new Text("boundary", 0, 0));
		transcript.addChild(last);
		transcript.render(80);
		const snapshot = vi.spyOn(first, "presentationSnapshot", "get");
		transcript.render(40);
		expect(snapshot).not.toHaveBeenCalled();
		last.updateArgs({ path: "changed.ts" });
		expect(transcript.render(40).join("\n")).toContain("changed.ts");
		expect(snapshot).not.toHaveBeenCalled();
		transcript.dispose();
	});

	it("keeps a completed exploration group cached while the following answer streams", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		const tool = read("stable");
		const assistant = new AssistantMessageComponent(fauxAssistantMessage("first"));
		transcript.addChild(tool);
		transcript.addChild(assistant);
		transcript.render(80);
		const snapshot = vi.spyOn(tool, "presentationSnapshot", "get");
		assistant.updateContent(fauxAssistantMessage("first and streamed continuation"));
		expect(transcript.render(80).join("\n")).toContain("streamed continuation");
		expect(snapshot).not.toHaveBeenCalled();
		transcript.dispose();
	});

	it("reprojects a thinking-only assistant when streamed text makes it a boundary", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		transcript.addChild(read("before"));
		const assistant = new AssistantMessageComponent(fauxAssistantMessage(""), true);
		transcript.addChild(assistant);
		transcript.addChild(read("after"));
		expect(
			transcript
				.render(80)
				.join("\n")
				.match(/Explored/g),
		).toHaveLength(1);
		assistant.updateContent(fauxAssistantMessage("visible answer"));
		const lines = transcript.render(80).join("\n");
		expect(lines.match(/Explored/g)).toHaveLength(2);
		expect(lines).toContain("visible answer");
		transcript.dispose();
	});

	it("honors explicit replacement and reorder invalidation without stale projected cards", () => {
		const transcript = new ExplorationTranscriptContainer(options);
		transcript.addChild(read("first"));
		const boundary = new Text("boundary", 0, 0);
		transcript.addChild(boundary);
		transcript.addChild(read("last"));
		transcript.render(80);
		transcript.children.splice(1, 1);
		transcript.markProjectionDirty(1);
		expect(
			transcript
				.render(80)
				.join("\n")
				.match(/Explored/g),
		).toHaveLength(1);
		transcript.children.splice(1, 0, boundary);
		transcript.markProjectionDirty(1);
		expect(
			transcript
				.render(80)
				.join("\n")
				.match(/Explored/g),
		).toHaveLength(2);
		transcript.dispose();
	});
});
