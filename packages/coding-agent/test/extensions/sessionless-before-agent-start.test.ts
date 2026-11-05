// senpi#5726 (S33): a runner without a session (every hand runtime) dispatches before_agent_start to an extension
// instead of throwing while it builds the handler's context; the handler reads the current prompt through
// ctx.getSystemPrompt() exactly as in a session.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionError, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { bootstrapRuntime } from "../../src/core/runtime/bootstrap.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createToolDispatcher } from "../../src/core/tool-dispatch/tool-dispatcher.ts";
import { createInMemoryModelRegistry } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult } from "../utilities.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const appendsAndReads: ExtensionFactory = (pi) => {
	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: `${event.systemPrompt}\nseen=${ctx.getSystemPrompt() === event.systemPrompt}`,
	}));
};

describe("before_agent_start on a runner without a session (S33)", () => {
	it("runs the extension's handler and applies its result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "senpi-s33-sessionless-"));
		cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
		const dispatcher = createToolDispatcher({ runtime: "in-process" });
		cleanups.push(() => void dispatcher.dispose());
		const { extensionRunner } = bootstrapRuntime({
			cwd,
			settingsManager: SettingsManager.inMemory(),
			extensionsResult: await createTestExtensionsResult([appendsAndReads], cwd),
			modelRegistry: await createInMemoryModelRegistry(AuthStorage.inMemory()),
			toolDispatcher: dispatcher,
		});
		const errors: ExtensionError[] = [];
		extensionRunner.onError((error) => void errors.push(error));

		const result = await extensionRunner.emitBeforeAgentStart("go", undefined, "base prompt", { cwd });

		expect(errors).toEqual([]);
		expect(result?.systemPrompt).toBe("base prompt\nseen=true");
	});
});
