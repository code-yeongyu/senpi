import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, it, vi } from "vitest";
import permissionSystemExtension from "../../../src/core/extensions/builtin/permission-system/index.ts";
import { createHarness, createTestUiContext, getMessageText, getToolResult } from "../harness.ts";

const original = "ASYNC_PATH_PERMISSION_CONTENT";
const changed = "ASYNC_PATH_PERMISSION_CHANGED";

// senpi#6460: path-class rules make ask prepare identity before admitting the prompt.
it.each<{
	readonly tool: "read" | "write";
	readonly input: Parameters<typeof fauxToolCall>[1] & { readonly path: string };
	readonly answer: "Allow once" | "Deny";
	readonly prompts: 0 | 1;
	readonly denied: boolean;
	readonly reads: boolean;
	readonly file: string;
}>([
	{
		tool: "read",
		input: { path: "new.txt" },
		answer: "Allow once",
		prompts: 1,
		denied: false,
		reads: true,
		file: original,
	},
	{ tool: "read", input: { path: "new.txt" }, answer: "Deny", prompts: 1, denied: true, reads: false, file: original },
	{
		tool: "read",
		input: { path: "approved.txt" },
		answer: "Deny",
		prompts: 0,
		denied: false,
		reads: true,
		file: original,
	},
	{
		tool: "write",
		input: { path: "new.txt", content: changed },
		answer: "Allow once",
		prompts: 1,
		denied: false,
		reads: false,
		file: changed,
	},
	{
		tool: "write",
		input: { path: "new.txt", content: changed },
		answer: "Deny",
		prompts: 1,
		denied: true,
		reads: false,
		file: original,
	},
	{
		tool: "write",
		input: { path: "approved.txt", content: changed },
		answer: "Deny",
		prompts: 0,
		denied: false,
		reads: false,
		file: changed,
	},
])(
	"$tool $input.path with $answer honors the decision after asynchronous admission",
	async ({ tool, input, answer, prompts, denied, reads, file }) => {
		const harness = await createHarness({
			fileSettings: true,
			settingsContent: JSON.stringify({
				permissionPreset: "ask",
				permission: { read: { "approved.txt": "allow" }, edit: { "approved.txt": "allow" } },
			}),
			extensionFactories: [permissionSystemExtension],
		});
		let turn: Promise<void> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			writeFileSync(join(harness.tempDir, "approved.txt"), original);
			writeFileSync(join(harness.tempDir, "new.txt"), original);
			const select = vi.fn(async () => answer);
			await harness.session.bindExtensions({ uiContext: createTestUiContext({ select }) });
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, input), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			turn = harness.session.prompt("run the fixture operation");
			const terminal = await Promise.race([
				turn.then(() => "complete"),
				new Promise<string>((resolve) => {
					deadline = setTimeout(() => resolve("permission preflight did not settle"), 5_000);
				}),
			]);

			expect({ terminal, prompts: select.mock.calls.length }).toEqual({ terminal: "complete", prompts });
			const result = getToolResult(harness, tool);
			expect(result.isError).toBe(denied);
			expect(getMessageText(result).includes(original)).toBe(reads);
			expect(readFileSync(join(harness.tempDir, input.path), "utf8")).toBe(file);
		} finally {
			clearTimeout(deadline);
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			await turn?.catch(() => undefined);
			harness.cleanup();
		}
	},
	10_000,
);
