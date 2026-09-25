import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChildFactory } from "@code-yeongyu/senpi-desktop-service";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
// The desktop-service package's scripted engine: a real NDJSON JSON-RPC child, observed on the wire.
import { fakeEngineFactory, type SpawnLog } from "../../../desktop-service/test/harness.ts";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { createComputerUseExtension } from "../../src/core/extensions/builtin/computer-use/index.ts";
import permissionSystemExtension from "../../src/core/extensions/builtin/permission-system/index.ts";
import toolSearchExtension from "../../src/core/extensions/builtin/tool-search/index.ts";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

export interface ComputerUseHarnessOptions {
	/** The `computer` block written to the project `settings.json` before session_start. */
	readonly computer?: Readonly<Record<string, unknown>>;
	readonly platform?: string;
	/** The `--permission` flag value. */
	readonly permission?: string;
	/** Replies of the permission prompt, in order. */
	readonly promptReplies?: readonly string[];
	/** Replaces the scripted fake desktop engine. */
	readonly engineChild?: ChildFactory;
	/** Bind extensions with the recording test UI (default); `false` leaves binding to an rpc connection. */
	readonly bindTestUi?: boolean;
}

export interface ComputerUseHarness {
	readonly harness: Harness;
	readonly engine: SpawnLog;
	/** Every `ctx.ui.notify` message, in order. */
	readonly notifications: readonly string[];
	/** Titles of every permission prompt shown. */
	readonly prompts: readonly string[];
	/** Methods the fake engine received, in order. */
	methods(): readonly string[];
	/** Runs `/computer <args>` through `AgentSession.prompt` and returns the notification it produced. */
	command(args: string): Promise<string>;
	cleanup(): Promise<void>;
}

function uiContext(notifications: string[], prompts: string[], replies: readonly string[]): ExtensionUIContext {
	const pending = [...replies];
	return {
		select: async (title) => {
			prompts.push(title);
			return pending.shift();
		},
		confirm: async () => false,
		input: async () => undefined,
		notify: (message) => {
			notifications.push(message);
		},
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
			throw new Error("custom UI is not used by computer-use tests");
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
}

/**
 * A faux-provider session with the real permission-system, tool-search, and computer-use builtins in their
 * registration order. The computer-use engine is the desktop-service scripted fake desktop unless replaced.
 */
export async function createComputerUseHarness(options: ComputerUseHarnessOptions = {}): Promise<ComputerUseHarness> {
	const engine = fakeEngineFactory({ FAKE_ENGINE_DESKTOP: "1" });
	const engineChild = options.engineChild ?? engine.factory;
	const computerUse = createComputerUseExtension({
		platform: options.platform ?? "linux",
		engineChild: () => engineChild,
	});
	const harness = await createHarness({
		extensionFactories: [
			{ factory: permissionSystemExtension, path: "<builtin:permission-system>" },
			{ factory: toolSearchExtension, path: "<builtin:tool-search>" },
			{ factory: computerUse, path: "<builtin:computer-use>" },
		],
		...(options.permission === undefined
			? {}
			: { extensionFlagValues: new Map([["permission", options.permission]]) }),
	});
	const settingsDir = join(harness.tempDir, CONFIG_DIR_NAME);
	mkdirSync(settingsDir, { recursive: true });
	writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ computer: options.computer ?? {} }));
	const notifications: string[] = [];
	const prompts: string[] = [];
	if (options.bindTestUi ?? true) {
		await harness.session.bindExtensions({
			uiContext: uiContext(notifications, prompts, options.promptReplies ?? []),
		});
	}

	return {
		harness,
		engine,
		notifications,
		prompts,
		methods: () => engine.requests.map((request) => request.method),
		async command(args) {
			const before = notifications.length;
			await harness.session.prompt(`/computer ${args}`);
			return notifications.slice(before).join("\n");
		},
		async cleanup() {
			await emitSessionShutdownEvent(harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		},
	};
}

/** Lets the faux model make one tool call, then echo its result; returns the tool result text. */
export async function callTool(harness: Harness, toolName: string, args: Record<string, unknown>): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall(toolName, args), { stopReason: "toolUse" }),
		(context: { readonly messages: readonly { readonly role: string }[] }) => {
			const toolResult = [...context.messages].reverse().find((message) => message.role === "toolResult");
			return fauxAssistantMessage(toolResult === undefined ? "missing tool result" : getMessageText(toolResult));
		},
	]);
	await harness.session.prompt(`call ${toolName}`);
	const toolResult = [...harness.session.messages].reverse().find((message) => message.role === "toolResult");
	return getMessageText(toolResult);
}
