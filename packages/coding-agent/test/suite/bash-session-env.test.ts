import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { goalFilePath } from "../../src/core/extensions/builtin/goal/persistence.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { createBashTool, createBashToolDefinition } from "../../src/core/tools/bash.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const command = `printf '%s|%s' "\${PI_SESSION_CWD-unset}" "\${PI_GOAL_STORE_FILE-unset}"`;

describe("core bash session environment (#1663)", () => {
	let harness: Harness;
	beforeEach(async () => {
		vi.stubEnv("PI_SESSION_CWD", "stale-cwd");
		vi.stubEnv("PI_GOAL_STORE_FILE", "stale-goal.json");
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({ ...createBashTool(process.cwd()), name: "session_bash" });
					pi.registerTool({
						...createBashTool(process.cwd(), { exposeSessionEnvironment: false }),
						name: "no_session_bash",
					});
				},
			],
		});
		await harness.session.bindExtensions({});
	});
	afterEach(() => {
		harness.cleanup();
		vi.unstubAllEnvs();
	});

	it("exposes the active session cwd and goal-store file to a real shell child", async () => {
		const result = await harness.session.executeTool("session_bash", { command });
		const expected = goalFilePath(goalStoreRef(harness.sessionManager, harness.tempDir));
		expect(getMessageText(result)).toBe(`${harness.tempDir}|${expected}`);
	});

	it("clears inherited cwd and goal-store values when session exposure is disabled", async () => {
		const result = await harness.session.executeTool("no_session_bash", { command });
		expect(getMessageText(result)).toBe("unset|unset");
	});

	it("clears an inherited goal-store path when a hand-built context omits the optional getter", async () => {
		const ctx = harness.getExtensionRunner().createContext();
		const tool = createBashToolDefinition(harness.tempDir);
		const result = await tool.execute("no-goal", { command }, undefined, undefined, {
			...ctx,
			goalStoreFile: undefined,
		});
		expect(getMessageText(result)).toBe(`${harness.tempDir}|unset`);
	});
});
