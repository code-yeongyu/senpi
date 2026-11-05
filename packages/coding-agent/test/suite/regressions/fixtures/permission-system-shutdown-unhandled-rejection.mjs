// @ts-check
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "../../../../dist/core/auth-storage.js";
import { createEventBus } from "../../../../dist/core/event-bus.js";
import permissionSystemExtension from "../../../../dist/core/extensions/builtin/permission-system/index.js";
import { RejectedError } from "../../../../dist/core/extensions/builtin/permission-system/types.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../../dist/core/extensions/loader.js";
import { ExtensionRunner } from "../../../../dist/core/extensions/runner.js";
import { ModelRegistry } from "../../../../dist/core/model-registry.js";
import { ModelRuntime } from "../../../../dist/core/model-runtime.js";
import { SessionManager } from "../../../../dist/core/session-manager.js";
import { theme } from "../../../../dist/modes/interactive/theme/theme.js";

/** @returns {PromiseWithResolvers<void>} */
function deferred() {
	return Promise.withResolvers();
}

const tempDir = mkdtempSync(join(tmpdir(), "pi-perm-rejection-child-"));

try {
	// Use the built runtime, not the source utilities' tsx/provider-catalog import graph.
	const runtime = createExtensionRuntime();
	const eventBus = createEventBus();
	const extension = await loadExtensionFromFactory(
		permissionSystemExtension,
		tempDir,
		eventBus,
		runtime,
		"<inline:1>",
	);
	const sessionManager = SessionManager.create(tempDir);
	const modelRegistry = new ModelRegistry(
		await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, allowModelNetwork: false }),
	);
	const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry, eventBus);

	runner.setFlagValue("permission-preset", "ask");
	await runner.emit({ type: "session_start", reason: "startup" });

	const permissionAsked = deferred();
	const promptOpened = deferred();
	const releasePrompt = deferred();
	const unsubscribe = eventBus.on("permission_asked", () => permissionAsked.resolve());
	/** @type {import("../../../../dist/core/extensions/types.js").ExtensionUIContext} */
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
		custom: async () => {
			throw new Error("Unexpected custom dialog");
		},
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
	};
	runner.setUIContext(ui, "tui");

	const toolCallPromise = runner.emitToolCall({
		type: "tool_call",
		toolName: "bash",
		input: { command: "echo hello" },
		toolCallId: "call-1",
	});

	await Promise.all([permissionAsked.promise, promptOpened.promise]);
	// Keep the prompt open until the parent observes it and requests shutdown.
	const shutdownRequested = once(process.stdin, "data");
	process.stdout.write("permission prompt open\n");
	await shutdownRequested;
	process.stdin.pause();
	await runner.emit({ type: "session_shutdown", reason: "quit" });
	await new Promise((resolve) => setImmediate(() => resolve(undefined)));
	releasePrompt.resolve();

	const toolCallResult = await toolCallPromise;
	if (toolCallResult?.block !== true || toolCallResult.reason !== new RejectedError().message) {
		throw new Error(`Unexpected tool call result: ${JSON.stringify(toolCallResult)}`);
	}

	unsubscribe();
	process.stdout.write("permission shutdown handled\n");
} finally {
	if (existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true });
	}
}
