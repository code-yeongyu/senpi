import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { goalFilePath } from "../../src/core/extensions/builtin/goal/persistence.ts";
import { goalStoreRef } from "../../src/core/extensions/builtin/goal/store-ref.ts";
import { TerminalManager } from "../../src/core/extensions/builtin/terminal/manager.ts";
import { createPtyBashTool } from "../../src/core/extensions/builtin/terminal/tools/bash.ts";
import type {
	TerminalToolContext,
	TerminalToolResult,
} from "../../src/core/extensions/builtin/terminal/tools/context.ts";
import { normalizeToolExposure } from "../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "./harness.ts";

const command = `printf '%s|%s' "\${PI_SESSION_CWD-unset}" "\${PI_GOAL_STORE_FILE-unset}"`;

describe("terminal PTY bash session environment (#1663)", () => {
	let harness: Harness;
	let manager: TerminalManager;
	let terminal: TerminalToolContext;
	beforeEach(async () => {
		harness = await createHarness({ extensionFactories: [() => {}] });
		await harness.session.bindExtensions({});
		manager = new TerminalManager();
		terminal = {
			manager,
			cwd: harness.tempDir,
			defaultCols: 120,
			defaultRows: 40,
			getEnv: () => ({ ...process.env, PI_SESSION_CWD: "stale-cwd", PI_GOAL_STORE_FILE: "stale-goal.json" }),
		};
	});
	afterEach(async () => {
		await manager.teardown();
		harness.cleanup();
	});

	// #1678: the terminal replacement must preserve the core bash eval-only policy.
	it("declares eval exposure on the replacement bash tool", () => {
		expect(normalizeToolExposure(createPtyBashTool(terminal)).exposure).toBe("eval");
	});

	async function output(result: TerminalToolResult): Promise<string> {
		const id = result.details?.bash_id;
		if (typeof id !== "string") return result.content.map((block) => block.text).join("");
		const runtime = manager.get(id);
		if (!runtime) throw new Error(`Missing terminal session ${id}`);
		await runtime.session.waitExit();
		return runtime.fullOutput();
	}

	it.each([
		{ background: false, fallback: false },
		{ background: true, fallback: false },
		{ background: false, fallback: true },
		{ background: true, fallback: true },
	])(
		"exposes session paths to a real PTY child (background=$background, fallback=$fallback)",
		async ({ background, fallback }) => {
			const ctx = harness.getExtensionRunner().createContext();
			const tool = createPtyBashTool({ ...terminal, getSessionContext: () => ctx });
			const result = await tool.execute(
				"paths",
				{ command, run_in_background: background },
				undefined,
				undefined,
				fallback ? undefined : ctx,
			);
			const expected = goalFilePath(goalStoreRef(harness.sessionManager, harness.tempDir));
			expect(await output(result)).toBe(`${harness.tempDir}|${expected}`);
		},
	);

	it.each([false, true])("clears inherited paths without a session context (background=%s)", async (background) => {
		const result = await createPtyBashTool(terminal).execute("no-context", {
			command,
			run_in_background: background,
		});
		expect(await output(result)).toBe("unset|unset");
	});

	it("clears an inherited goal-store path when the context omits the optional getter", async () => {
		const ctx = harness.getExtensionRunner().createContext();
		const result = await createPtyBashTool(terminal).execute("no-goal", { command }, undefined, undefined, {
			...ctx,
			goalStoreFile: undefined,
		});
		expect(await output(result)).toBe(`${harness.tempDir}|unset`);
	});
});
