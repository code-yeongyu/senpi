import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.ts";

type ToolCallObservation = {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
};

interface FauxContext {
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

function extractToolResultText(context: FauxContext): string {
	const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
	return toolResult ? getMessageText(toolResult) : "missing tool result";
}

function createInlineExtension(state: {
	readonly execute: (params: { readonly q: string }) => void;
	readonly toolCallObservations: ToolCallObservation[];
	blockNext: boolean;
}): ExtensionFactory {
	return (pi) => {
		pi.registerTool({
			name: "demo_tool",
			label: "Demo Tool",
			description: "Returns a test marker.",
			parameters: Type.Object({ q: Type.String() }),
			execute: async (_toolCallId, params) => {
				state.execute(params);
				return {
					content: [{ type: "text", text: `demo:${params.q}` }],
					details: {},
				};
			},
		});

		pi.on("tool_call", (event) => {
			if (event.toolName !== "demo_tool") {
				return undefined;
			}
			state.toolCallObservations.push({ toolName: event.toolName, input: { ...event.input } });
			if (state.blockNext) {
				state.blockNext = false;
				return { block: true, reason: "denied" };
			}
			return undefined;
		});

		pi.on("tool_result", (event) => {
			if (event.toolName !== "demo_tool") {
				return undefined;
			}
			const text = event.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			return {
				content: [{ type: "text", text: `${text}:rewritten` }],
				details: event.details,
			};
		});
	};
}

async function createCodemodeHarness(options: {
	readonly extensionFactory: ExtensionFactory;
	readonly excludedToolNames?: string[];
	readonly disabledBuiltinExtensions?: string[];
}): Promise<Harness> {
	const tempDir = mkdtempSync(join(tmpdir(), "senpi-codemode-bridge-"));
	const settingsManager = SettingsManager.inMemory({
		disabledBuiltinExtensions: options.disabledBuiltinExtensions,
	});
	const loader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: join(tempDir, "agent"),
		settingsManager,
		extensionFactories: [options.extensionFactory],
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();

	const harness = await createHarness({
		resourceLoader: loader,
		excludedToolNames: options.excludedToolNames,
	});
	await harness.session.bindExtensions({});
	return {
		...harness,
		cleanup() {
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function runEvalTurn(harness: Harness, code: string): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("eval", { language: "js", code }), { stopReason: "toolUse" }),
		(context: FauxContext) => fauxAssistantMessage(extractToolResultText(context)),
	]);

	await harness.session.prompt("run eval");
	return getAssistantTexts(harness).join("\n");
}

describe("bundled codemode bridge", () => {
	it("routes JS eval tool calls through extension tools and hooks", async () => {
		const state = {
			execute: vi.fn((params: { readonly q: string }) => {
				void params;
			}),
			toolCallObservations: [] as ToolCallObservation[],
			blockNext: false,
		};
		const harness = await createCodemodeHarness({ extensionFactory: createInlineExtension(state) });

		try {
			const output = await runEvalTurn(harness, 'return await tool.demo_tool({q:"hi"})');
			expect(state.execute).toHaveBeenCalledExactlyOnceWith({ q: "hi" });
			expect(state.toolCallObservations).toEqual([{ toolName: "demo_tool", input: { q: "hi" } }]);
			expect(output).toContain("demo:hi:rewritten");
		} finally {
			harness.cleanup();
		}
	});

	it("returns a bridge-visible error when a tool_call hook blocks execution", async () => {
		const state = {
			execute: vi.fn((params: { readonly q: string }) => {
				void params;
			}),
			toolCallObservations: [] as ToolCallObservation[],
			blockNext: true,
		};
		const harness = await createCodemodeHarness({ extensionFactory: createInlineExtension(state) });

		try {
			const output = await runEvalTurn(harness, 'return await tool.demo_tool({q:"blocked"})');

			expect(state.execute).not.toHaveBeenCalled();
			expect(state.toolCallObservations).toEqual([{ toolName: "demo_tool", input: { q: "blocked" } }]);
			expect(output).toContain("denied");
		} finally {
			harness.cleanup();
		}
	});

	it("completes without hanging when permission ask is denied inside the bridge", async () => {
		const state = {
			execute: vi.fn((params: { readonly q: string }) => {
				void params;
			}),
			toolCallObservations: [] as ToolCallObservation[],
			blockNext: false,
		};
		const harness = await createCodemodeHarness({ extensionFactory: createInlineExtension(state) });
		const settingsDir = join(harness.tempDir, CONFIG_DIR_NAME);
		mkdirSync(settingsDir, { recursive: true });
		writeFileSync(join(settingsDir, "settings.json"), `${JSON.stringify({ permission: { demo_tool: "ask" } })}\n`);
		const uiContext = {
			select: vi.fn(async () => "Deny"),
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingIndicator: () => {},
			setWorkingVisible: () => {},
			addAutocompleteProvider: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async <T>(): Promise<T> => {
				throw new Error("custom UI not implemented in test");
			},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			theme,
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: true }),
			getToolsExpanded: () => true,
			setToolsExpanded: () => {},
		};

		try {
			await harness.session.bindExtensions({ uiContext });
			const output = await runEvalTurn(harness, 'return await tool.demo_tool({q:"ask"})');

			expect(uiContext.select).toHaveBeenCalled();
			expect(state.execute).not.toHaveBeenCalled();
			expect(output).toContain("rejected");
		} finally {
			harness.cleanup();
		}
	});

	it("respects disabledBuiltinExtensions and --exclude-tools for codemode", async () => {
		const disabledHarness = await createCodemodeHarness({
			extensionFactory: () => {},
			disabledBuiltinExtensions: ["codemode"],
		});
		try {
			expect(disabledHarness.session.getActiveToolNames()).not.toContain("eval");
		} finally {
			disabledHarness.cleanup();
		}

		const excludedHarness = await createCodemodeHarness({
			extensionFactory: () => {},
			excludedToolNames: ["eval"],
		});
		try {
			expect(excludedHarness.session.getActiveToolNames()).not.toContain("eval");
		} finally {
			excludedHarness.cleanup();
		}
	});
});
