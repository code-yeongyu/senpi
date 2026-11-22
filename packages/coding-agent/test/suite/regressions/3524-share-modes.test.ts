import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { buildInitialMessage } from "../../../src/cli/initial-message.ts";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { UnknownCommandError } from "../../../src/core/unknown-command.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { getModelRuntime } from "../../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

// senpi#3524: /share runs only behind the interactive preview and confirm. Print, piped and RPC
// runs must refuse it before anything reaches GitHub, so the gh adapter is stubbed and must stay untouched.
const gh = vi.hoisted(() => ({ checkGhAuth: vi.fn(), uploadSecretGist: vi.fn() }));
vi.mock("../../../src/core/share/share-gh.ts", () => gh);
vi.mock("../../../src/core/output-guard.ts", () => ({
	flushRawStdout: async () => {},
	waitForRawStdoutBackpressure: async () => {},
	writeRawStdout: () => {},
}));

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
	gh.checkGhAuth.mockClear();
	gh.uploadSecretGist.mockClear();
});

async function printRun(
	argv: string[],
	stdinContent?: string,
): Promise<{ exit: number; errors: string[]; harness: Harness }> {
	const harness = await createHarness();
	harnesses.push(harness);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "agent"),
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			modelRuntime: getModelRuntime(harness.modelRegistry),
			settingsManager: harness.settingsManager,
			resourceLoader: createTestResourceLoader(),
			diagnostics: [],
		},
		async () => {
			throw new Error("This scenario does not replace the runtime");
		},
	);
	const { initialMessage } = buildInitialMessage({ parsed: parseArgs(argv), stdinContent });
	const errors: string[] = [];
	vi.spyOn(console, "error").mockImplementation((message: unknown) => {
		errors.push(String(message));
	});
	const exit = await runPrintMode(runtime, { mode: "text", initialMessage });
	return { exit, errors, harness };
}

function expectNoShare(harness: Harness): void {
	expect(gh.checkGhAuth).not.toHaveBeenCalled();
	expect(gh.uploadSecretGist).not.toHaveBeenCalled();
	expect(getUserTexts(harness)).toEqual([]);
}

describe("/share outside the interactive TUI (senpi#3524)", () => {
	it("print mode refuses /share and never reaches gh", async () => {
		const { exit, errors, harness } = await printRun(["-p", "/share"]);
		expect(exit).toBe(1);
		expect(errors.join("\n")).toContain("share");
		expectNoShare(harness);
	});

	it("a piped run refuses /share and never reaches gh", async () => {
		const { exit, harness } = await printRun(["-p"], "/share\n");
		expect(exit).toBe(1);
		expectNoShare(harness);
	});

	it("an RPC prompt refuses /share as interactive-only and never reaches gh", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const error = await harness.session.prompt("/share", { source: "rpc" }).then(
			() => undefined,
			(cause: unknown) => cause,
		);
		expect(error).toBeInstanceOf(UnknownCommandError);
		expect(error instanceof UnknownCommandError ? error.reason : undefined).toBe("interactive_only");
		expectNoShare(harness);
	});
});
