import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

class ProcessExitError extends Error {
	readonly code: string | number | null | undefined;

	constructor(code: string | number | null | undefined) {
		super(`process.exit(${String(code)})`);
		this.code = code;
	}
}

/**
 * The --neo launcher must hand off BEFORE any runtime/extension machinery runs.
 * We mock the neo spawn seam so no real child process starts, mock the runtime
 * factories to throw if ever touched, and assert main() dispatched to neo
 * without constructing an AgentSessionRuntime or loading extensions.
 */
describe("--neo early dispatch (no runtime, zero extensions)", () => {
	const tempDirs: string[] = [];
	let originalAgentDir: string | undefined;
	let originalNeoBin: string | undefined;
	let originalCwd = process.cwd();
	let originalExitCode: typeof process.exitCode = process.exitCode;
	const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

	/** Simulate a real interactive terminal so appMode resolves to "interactive". */
	function makeInteractiveTTY(): void {
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
	}

	function restoreTTY(): void {
		if (originalStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", originalStdinIsTTY);
		else Reflect.deleteProperty(process.stdin, "isTTY");
		if (originalStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
		else Reflect.deleteProperty(process.stdout, "isTTY");
	}

	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		restoreTTY();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		if (originalAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = originalAgentDir;
		if (originalNeoBin === undefined) delete process.env.SENPI_NEO_BIN;
		else process.env.SENPI_NEO_BIN = originalNeoBin;
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function createTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-neo-dispatch-"));
		tempDirs.push(dir);
		return dir;
	}

	it("dispatches to the neo binary and never builds a runtime or loads extensions", async () => {
		vi.resetModules();

		const runNeoLauncherMock = vi.fn(async () => 0);
		vi.doMock("../src/cli/neo/launch.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/cli/neo/launch.ts")>();
			return { ...actual, runNeoLauncher: runNeoLauncherMock };
		});

		const servicesMock = vi.fn(async () => {
			throw new Error("--neo must not create agent session services");
		});
		vi.doMock("../src/core/agent-session-services.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-services.ts")>();
			return { ...actual, createAgentSessionServices: servicesMock };
		});

		const runtimeMock = vi.fn(async () => {
			throw new Error("--neo must not create an agent session runtime");
		});
		vi.doMock("../src/core/agent-session-runtime.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/core/agent-session-runtime.ts")>();
			return { ...actual, createAgentSessionRuntime: runtimeMock };
		});

		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalNeoBin = process.env.SENPI_NEO_BIN;
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.SENPI_NEO_BIN = join(tempDir, "stub-neo");
		process.exitCode = undefined;
		process.chdir(projectDir);

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});
		makeInteractiveTTY();

		await expect(main(["--neo"])).rejects.toMatchObject({ code: 0 });

		expect(runNeoLauncherMock).toHaveBeenCalledTimes(1);
		expect(servicesMock).not.toHaveBeenCalled();
		expect(runtimeMock).not.toHaveBeenCalled();
	});

	it("--neo --help shows classic help (which now lists --neo) instead of handing off", async () => {
		vi.resetModules();
		// Clear any per-test module mocks from earlier cases so the real runtime runs.
		vi.doUnmock("../src/core/agent-session-services.ts");
		vi.doUnmock("../src/core/agent-session-runtime.ts");

		const runNeoLauncherMock = vi.fn(async () => 0);
		vi.doMock("../src/cli/neo/launch.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../src/cli/neo/launch.ts")>();
			return { ...actual, runNeoLauncher: runNeoLauncherMock };
		});

		const { main } = await import("../src/main.ts");

		const tempDir = createTempDir();
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalNeoBin = process.env.SENPI_NEO_BIN;
		originalCwd = process.cwd();
		originalExitCode = process.exitCode;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.exitCode = undefined;
		process.chdir(projectDir);

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined): never => {
			throw new ProcessExitError(code);
		});
		makeInteractiveTTY();

		await expect(main(["--neo", "--help"])).rejects.toMatchObject({ code: 0 });
		expect(runNeoLauncherMock).not.toHaveBeenCalled();
		const helpText = logSpy.mock.calls.map(([m]) => String(m)).join("\n");
		expect(helpText).toContain("--neo");
	});
});
