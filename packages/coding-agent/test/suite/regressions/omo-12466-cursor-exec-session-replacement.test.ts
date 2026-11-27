import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type SimpleStreamOptions, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionCursorExecBridge } from "../../../src/core/cursor-exec-bridge-session.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

// omo#12466: on the Cursor exec path, a result an extension's tool_result handler replaced (the memory guard does,
// when a second memory identity appears while a recursive search runs) must be what the exec frame answers, as on
// the agent loop. Synthetic names only: the "identities" are made-up directory names, nothing is read from disk.
const FOREIGN_LINE = "late-id/repo/system/persona.md:1: synthetic-foreign-line";
const DENY = "cross-identity memory access denied: synthetic";

type GrepFrame = (call: { toolCallId: string; args: { pattern: string; path?: string } }) => Promise<unknown>;

function isToolResult(value: unknown): value is ToolResultMessage {
	return typeof value === "object" && value !== null && "role" in value && value.role === "toolResult";
}

describe("a tool_result replacement on the Cursor exec path, through AgentSession (omo#12466)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function runGrepFrame(path: (tempDir: string) => string) {
		const grepExecute = vi.fn(async () => ({
			content: [{ type: "text" as const, text: FOREIGN_LINE }],
			details: {},
		}));
		const grep: AgentTool = {
			name: "grep",
			label: "grep",
			description: "grep-shaped fixture",
			parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()) }),
			execute: grepExecute,
		};
		const harness = await createHarness({
			tools: [grep],
			extensionFactories: [
				(pi) => {
					// An identity that exists when the call starts is refused before the walk (the control case).
					pi.on("tool_call", (event) =>
						JSON.stringify(event.input).includes("existing-id") ? { block: true, reason: DENY } : undefined,
					);
					// An identity that appeared during the walk: the whole result is replaced, as the memory guard does.
					pi.on("tool_result", (event) =>
						getMessageText(event).includes("synthetic-foreign-line")
							? { content: [{ type: "text", text: DENY }], isError: true, details: {} }
							: undefined,
					);
				},
			],
		});
		harnesses.push(harness);
		// The production wiring (sdk.ts): a per-run bridge factory over the session.
		harness.agent.cursorExecHandlers = (runSignal) =>
			createSessionCursorExecBridge({ current: harness.session }, () => harness.agent, runSignal);
		let frame: unknown;
		harness.setResponses([
			async (_context, options) => {
				const { execHandlers } = options as SimpleStreamOptions & { execHandlers: { piGrep: GrepFrame } };
				frame = await execHandlers.piGrep({
					toolCallId: "cursor-frame",
					args: { pattern: "synthetic", path: path(harness.tempDir) },
				});
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("search the memory folder");

		if (!isToolResult(frame)) throw new Error("the exec frame answered no tool result");
		const ends = harness.eventsOfType("tool_execution_end").filter((event) => event.toolCallId === "cursor-frame");
		return { frame, ends, grepExecute };
	}

	it("answers the exec frame with the extension's replacement, not with what the walk found", async () => {
		const { frame, ends, grepExecute } = await runGrepFrame((tempDir) => join(tempDir, "memory"));

		expect(grepExecute).toHaveBeenCalledTimes(1);
		expect(frame.isError).toBe(true);
		expect(frame.content).toEqual([{ type: "text", text: DENY }]);
		expect(ends).toHaveLength(1);
		expect(JSON.stringify(ends[0]?.result)).not.toContain("synthetic-foreign-line");
	});

	it("still refuses a call whose identity exists before it starts, without running the tool", async () => {
		const { frame, grepExecute } = await runGrepFrame((tempDir) => join(tempDir, "memory", "agents", "existing-id"));

		expect(grepExecute).not.toHaveBeenCalled();
		expect(frame.isError).toBe(true);
		expect(getMessageText(frame)).toContain(DENY);
	});
});
