import { sep } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { InlineExtension } from "../../src/index.ts";
import { explorationSurface, invoke, runTool } from "./exploration-surface-harness.ts";

// senpi#2060: a skill load or a memory recall is a semantic card, not file exploration.
const recallClassifier: InlineExtension = (pi) => {
	pi.registerReadClassifier(({ absolutePath }) =>
		absolutePath.endsWith(`${sep}notes.md`) ? { kind: "memory", label: "notes", headline: "Recalled" } : undefined,
	);
};

describe("semantic reads and the exploration group", () => {
	it("keeps a skill load as its own [skill] card and splits the group around it", async () => {
		const surface = await explorationSurface();
		try {
			await runTool(surface, { id: "a", toolName: "read", args: { path: "src/a.ts" } });
			await runTool(surface, { id: "skill", toolName: "read", args: { path: "skills/demo/SKILL.md" } });
			await runTool(surface, { id: "b", toolName: "read", args: { path: "src/b.ts" } });
			const text = surface.text();
			expect(text.match(/Explored/g)).toHaveLength(2);
			expect(text).toContain("[skill] demo");
			expect(text).not.toContain("SKILL.md");
			expect(text.indexOf("Read a.ts")).toBeLessThan(text.indexOf("[skill] demo"));
			expect(text.indexOf("[skill] demo")).toBeLessThan(text.indexOf("Read b.ts"));
		} finally {
			surface.cleanup();
		}
	});

	it("names every loaded skill instead of one deduplicated SKILL.md line", async () => {
		const surface = await explorationSurface();
		try {
			await runTool(surface, { id: "alpha", toolName: "read", args: { path: "skills/alpha/SKILL.md" } });
			await runTool(surface, { id: "beta", toolName: "read", args: { path: "skills/beta/SKILL.md" } });
			const text = surface.text();
			expect(text).toContain("[skill] alpha");
			expect(text).toContain("[skill] beta");
			expect(text).not.toContain("Explored");
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a memory read claimed by a registered classifier as its Recalled card", async () => {
		const surface = await explorationSurface(true, [recallClassifier]);
		try {
			await runTool(surface, { id: "a", toolName: "read", args: { path: "src/a.ts" } });
			await runTool(surface, { id: "memory", toolName: "read", args: { path: "memory/notes.md" } });
			await runTool(surface, { id: "b", toolName: "read", args: { path: "src/b.ts" } });
			const text = surface.text();
			expect(text.match(/Explored/g)).toHaveLength(2);
			expect(text).toContain("✦ Recalled notes");
			expect(text).not.toContain("notes.md");
		} finally {
			surface.cleanup();
		}
	});

	it("still groups docs and resource reads with ordinary reads", async () => {
		const surface = await explorationSurface();
		try {
			await runTool(surface, { id: "a", toolName: "read", args: { path: "src/a.ts" } });
			await runTool(surface, { id: "agents", toolName: "read", args: { path: "AGENTS.md" } });
			await runTool(surface, { id: "b", toolName: "read", args: { path: "src/b.ts" } });
			const text = surface.text();
			expect(text.match(/Explored/g)).toHaveLength(1);
			expect(text).toContain("Read a.ts, AGENTS.md, b.ts");
		} finally {
			surface.cleanup();
		}
	});

	it("renders the same split from replay as from the live stream", async () => {
		const live = await explorationSurface();
		const replay = await explorationSurface();
		try {
			const calls = [
				{ type: "toolCall", id: "a", name: "read", arguments: { path: "src/a.ts" } },
				{ type: "toolCall", id: "skill", name: "read", arguments: { path: "skills/demo/SKILL.md" } },
				{ type: "toolCall", id: "b", name: "read", arguments: { path: "src/b.ts" } },
			] as const;
			const message: AssistantMessage = { ...fauxAssistantMessage(""), content: [...calls], stopReason: "toolUse" };
			await live.event({ type: "message_start", message });
			for (const [contentIndex, toolCall] of calls.entries()) {
				await live.event({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex, toolCall, partial: message },
				});
			}
			await live.event({ type: "message_end", message });
			const results: ToolResultMessage[] = calls.map((call) => ({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [{ type: "text", text: `result-${call.id}` }],
				isError: false,
				timestamp: 0,
			}));
			for (const result of results) {
				await live.event({
					type: "tool_execution_end",
					toolCallId: result.toolCallId,
					toolName: result.toolName,
					result,
					isError: false,
				});
			}
			invoke(replay.mode, "renderSessionItems", [message, ...results]);
			expect(live.text().match(/Explored/g)).toHaveLength(2);
			expect(live.text()).toContain("[skill] demo");
			for (const expanded of [false, true]) {
				invoke(live.mode, "setToolsExpanded", expanded);
				invoke(replay.mode, "setToolsExpanded", expanded);
				for (const width of [80, 120]) expect(replay.text(width)).toBe(live.text(width));
			}
		} finally {
			live.cleanup();
			replay.cleanup();
		}
	});
});
