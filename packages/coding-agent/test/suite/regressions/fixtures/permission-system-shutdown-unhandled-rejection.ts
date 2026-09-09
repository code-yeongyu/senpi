import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../../../src/core/auth-storage.ts";
import permissionSystemExtension from "../../../../src/core/extensions/builtin/permission-system/index.ts";
import { ExtensionRunner } from "../../../../src/core/extensions/runner.ts";
import type { ExtensionUIContext } from "../../../../src/core/extensions/types.ts";
import { SessionManager } from "../../../../src/core/session-manager.ts";
import { theme } from "../../../../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "../../../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../../../utilities.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-rejection-child-"));

try {
	const extensionsResult = await createTestExtensionsResult([permissionSystemExtension], tempDir);
	const eventBus = extensionsResult.eventBus;
	if (!eventBus) throw new Error("Expected the test extension event bus");
	const sessionManager = SessionManager.create(tempDir);
	const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runner = new ExtensionRunner(
		extensionsResult.extensions,
		extensionsResult.runtime,
		tempDir,
		sessionManager,
		modelRegistry,
		eventBus,
	);

	runner.setFlagValue("permission-preset", "ask");
	await runner.emit({ type: "session_start", reason: "startup" });

	const permissionAsked = deferred();
	const promptOpened = deferred();
	const releasePrompt = deferred();
	const unsubscribe = eventBus.on("permission_asked", () => permissionAsked.resolve());
	const ui = {
		select: async () => {
			promptOpened.resolve();
			await releasePrompt.promise;
			return undefined;
		},
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme,
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "UI not available" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	} satisfies ExtensionUIContext;
	runner.setUIContext(ui, "tui");

	const toolCallPromise = runner.emitToolCall({
		type: "tool_call",
		toolName: "bash",
		input: { command: "echo hello" },
		toolCallId: "call-1",
	});

	await Promise.all([permissionAsked.promise, promptOpened.promise]);
	await runner.emit({ type: "session_shutdown", reason: "quit" });
	await new Promise<void>((resolve) => setImmediate(resolve));
	releasePrompt.resolve();

	const toolCallResult = await toolCallPromise;
	if (
		toolCallResult?.block !== true ||
		toolCallResult.reason !== "The user rejected permission to use this specific tool call."
	) {
		throw new Error(`Unexpected tool call result: ${JSON.stringify(toolCallResult)}`);
	}

	unsubscribe();
	process.stdout.write("permission shutdown handled\n");
} finally {
	if (existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true });
	}
}
