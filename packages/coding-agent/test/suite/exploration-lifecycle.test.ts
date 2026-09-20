import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { ToolExecutionComponent } from "../../src/modes/interactive/components/tool-execution.ts";
import { explorationSurface, invoke } from "./exploration-surface-harness.ts";

// senpi#1870: presentation must not take ownership of call IDs or tool results.
describe("exploration lifecycle boundaries", () => {
	it("keeps partial arguments and out-of-order results routed to their original cards", async () => {
		const surface = await explorationSurface();
		try {
			await surface.event({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: {} });
			const first = surface.chat.children.find((child) => child instanceof ToolExecutionComponent);
			expect(first).toBeDefined();
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "a",
				toolName: "read",
				args: { path: "sample.ts", offset: 1, limit: 20 },
			});
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "b",
				toolName: "read",
				args: { path: "sample.ts", offset: 21, limit: 20 },
			});
			await surface.event({
				type: "tool_execution_update",
				toolCallId: "a",
				toolName: "read",
				args: { path: "sample.ts", offset: 1, limit: 20 },
				partialResult: { content: [{ type: "text", text: "PARTIAL_A" }] },
			});
			await surface.event({
				type: "tool_execution_end",
				toolCallId: "b",
				toolName: "read",
				result: { content: [{ type: "text", text: "FINAL_B" }] },
				isError: false,
			});
			const pending = Reflect.get(surface.mode, "pendingTools");
			expect(pending.size).toBe(1);
			expect(pending.get("a")).toBe(first);
			expect(surface.text()).toContain("Exploring");
			await surface.event({
				type: "tool_execution_end",
				toolCallId: "a",
				toolName: "read",
				result: { content: [{ type: "text", text: "FINAL_A" }] },
				isError: false,
			});
			expect(surface.text()).toContain("2 reads; requested 1-40");
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.text()).toContain("FINAL_A");
			expect(surface.text()).toContain("FINAL_B");
			expect(surface.text()).not.toContain("PARTIAL_A");
			expect(surface.text().indexOf("FINAL_A")).toBeLessThan(surface.text().indexOf("FINAL_B"));
			expect(pending.size).toBe(0);
		} finally {
			surface.cleanup();
		}
	});

	it("keeps a failed read in the group and exposes its original error on expansion", async () => {
		const surface = await explorationSurface();
		try {
			for (const id of ["missing", "found"]) {
				await surface.event({
					type: "tool_execution_start",
					toolCallId: id,
					toolName: "read",
					args: { path: `${id}.ts` },
				});
				await surface.event({
					type: "tool_execution_end",
					toolCallId: id,
					toolName: "read",
					result: { content: [{ type: "text", text: id === "missing" ? "ENOENT fixture" : "actual output" }] },
					isError: id === "missing",
				});
			}
			expect(surface.text().match(/Explored/g)).toHaveLength(1);
			expect(surface.text()).toContain("1 failed");
			expect(surface.text()).toContain("[failed]");
			invoke(surface.mode, "setToolsExpanded", true);
			expect(surface.text()).toContain("ENOENT fixture");
			expect(surface.text()).toContain("actual output");
		} finally {
			surface.cleanup();
		}
	});

	it("marks cancelled pending calls failed with the same live and replay output", async () => {
		const live = await explorationSurface();
		const replay = await explorationSurface();
		try {
			const call = { type: "toolCall", id: "cancelled", name: "read", arguments: { path: "sample.ts" } } as const;
			const message = {
				...fauxAssistantMessage(""),
				content: [call],
				stopReason: "aborted",
				errorMessage: "Cancelled fixture",
			} as const;
			const mutableMessage = { ...message, content: [call] };
			await live.event({ type: "message_start", message: mutableMessage });
			await live.event({
				type: "message_update",
				message: mutableMessage,
				assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: mutableMessage },
			});
			await live.event({ type: "message_end", message: mutableMessage });
			invoke(replay.mode, "renderSessionItems", [mutableMessage]);
			expect(live.text()).toContain("1 failed");
			expect(live.text()).not.toContain("Exploring");
			expect(Reflect.get(live.mode, "pendingTools").size).toBe(0);
			invoke(live.mode, "setToolsExpanded", true);
			invoke(replay.mode, "setToolsExpanded", true);
			expect(live.text()).toContain("Cancelled fixture");
			expect(replay.text()).toBe(live.text());
		} finally {
			live.cleanup();
			replay.cleanup();
		}
	});

	it("treats ordinary tools and visible messages as boundaries", async () => {
		const surface = await explorationSurface();
		try {
			for (const [id, toolName] of [
				["a", "read"],
				["normal", "bash"],
				["b", "read"],
			] as const) {
				await surface.event({
					type: "tool_execution_start",
					toolCallId: id,
					toolName,
					args: { path: `${id}.ts`, command: "echo normal" },
				});
				await surface.event({
					type: "tool_execution_end",
					toolCallId: id,
					toolName,
					result: { content: [{ type: "text", text: `${id}-result` }] },
					isError: false,
				});
			}
			surface.chat.addChild(new Text("Visible boundary", 0, 0));
			await surface.event({
				type: "tool_execution_start",
				toolCallId: "c",
				toolName: "read",
				args: { path: "c.ts" },
			});
			expect(surface.text().match(/Explored/g)).toHaveLength(2);
			expect(surface.text()).toContain("Exploring");
			expect(surface.text()).toContain("echo normal");
			expect(surface.text()).toContain("Visible boundary");
		} finally {
			surface.cleanup();
		}
	});
});
