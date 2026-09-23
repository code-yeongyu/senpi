import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { explorationSurface, invoke, runTool } from "./exploration-surface-harness.ts";

// senpi#2042: codex-exact exploration groups through the real interactive event seam.
describe("exploration through interactive events", () => {
	it("renders three reads of one file, a search and a listing as one codex-shaped group", async () => {
		const surface = await explorationSurface();
		try {
			const calls: ToolCall[] = [1, 201, 401].map((offset, index) => ({
				type: "toolCall",
				id: `read-${index}`,
				name: "read",
				arguments: { path: "src/sample.ts", offset, limit: 200 },
			}));
			calls.push(
				{ type: "toolCall", id: "search", name: "grep", arguments: { pattern: "needle", path: "src" } },
				{ type: "toolCall", id: "list", name: "ls", arguments: { path: "src/nested" } },
			);
			const message: AssistantMessage = { ...fauxAssistantMessage(""), content: calls, stopReason: "toolUse" };
			await surface.event({ type: "message_start", message });
			for (const [index, call] of calls.entries()) {
				await surface.event({
					type: "message_update",
					message,
					assistantMessageEvent: { type: "toolcall_end", contentIndex: index, toolCall: call, partial: message },
				});
			}
			await surface.event({ type: "message_end", message });
			for (const call of calls) await runTool(surface, { id: call.id, toolName: call.name, args: call.arguments });
			const answer = fauxAssistantMessage("Answer after exploration");
			await surface.event({ type: "message_start", message: answer });
			await surface.event({ type: "message_end", message: answer });
			await runTool(surface, {
				id: "edit",
				toolName: "edit",
				args: { path: "src/edited.ts", edits: [{ oldText: "a", newText: "b" }] },
			});

			const compact = surface.text();
			// Three reads of one file collapse into one name, never three cards.
			expect(compact.match(/sample\.ts/g)).toHaveLength(1);
			expect(compact.match(/Explored/g)).toHaveLength(1);
			expect(compact).toContain("• Explored");
			expect(compact).toContain("└ Read sample.ts");
			expect(compact).toContain("Search needle in src");
			expect(compact).toContain("List nested");
			for (const range of ["1-200", "201-400", "401-600", "reads"]) expect(compact).not.toContain(range);
			expect(compact).not.toContain("original-result-read");
			expect(compact.indexOf("List nested")).toBeLessThan(compact.indexOf("Answer after exploration"));
			// The edit after the answer is its own card, outside the group.
			expect(compact).toContain("edited.ts");
			expect(compact.indexOf("Answer after exploration")).toBeLessThan(compact.indexOf("edited.ts"));

			invoke(surface.mode, "setToolsExpanded", true);
			const expanded = surface.text();
			expect(expanded.match(/Explored/g)).toHaveLength(1);
			for (const id of ["read-0", "read-1", "read-2", "search", "list"]) {
				expect(expanded).toContain(`original-result-${id}`);
			}
			expect(expanded.indexOf("original-result-read-0")).toBeLessThan(expanded.indexOf("original-result-read-2"));
			expect(Reflect.get(surface.mode, "pendingTools").size).toBe(0);
		} finally {
			surface.cleanup();
		}
	});

	it("starts a following edit outside the group and never absorbs eval", async () => {
		const surface = await explorationSurface();
		try {
			await runTool(surface, { id: "a", toolName: "read", args: { path: "a.ts" } });
			await runTool(surface, { id: "edit", toolName: "edit", args: { path: "a.ts", edits: [] } });
			await runTool(surface, { id: "b", toolName: "read", args: { path: "b.ts" } });
			await runTool(surface, { id: "eval", toolName: "eval", args: { language: "js", code: "1" } });
			await runTool(surface, { id: "c", toolName: "read", args: { path: "c.ts" } });
			const compact = surface.text();
			expect(compact.match(/Explored/g)).toHaveLength(3);
			expect(compact.indexOf("Read a.ts")).toBeLessThan(compact.indexOf("Read b.ts"));
			expect(compact).toContain("original-result-eval");
			expect(compact.indexOf("original-result-eval")).toBeLessThan(compact.indexOf("Read c.ts"));
			expect(compact.indexOf("Read b.ts")).toBeLessThan(compact.indexOf("original-result-eval"));
		} finally {
			surface.cleanup();
		}
	});

	it("deduplicates names in first-seen order and caps the body at eight lines", async () => {
		const surface = await explorationSurface();
		try {
			for (const [index, path] of ["b.ts", "a.ts", "dir/b.ts"].entries()) {
				await runTool(surface, { id: `r${index}`, toolName: "read", args: { path } });
			}
			for (let index = 0; index < 9; index++) {
				await runTool(surface, { id: `g${index}`, toolName: "grep", args: { pattern: `p${index}` } });
			}
			const compact = surface.text();
			expect(compact).toContain("Read b.ts, a.ts");
			expect(compact).not.toContain("Read b.ts, a.ts, b.ts");
			for (let index = 0; index < 7; index++) expect(compact).toContain(`Search p${index}`);
			expect(compact).not.toContain("Search p7");
			expect(compact).not.toContain(" in ");
			expect(compact).toContain("… +2 more");
		} finally {
			surface.cleanup();
		}
	});
});
