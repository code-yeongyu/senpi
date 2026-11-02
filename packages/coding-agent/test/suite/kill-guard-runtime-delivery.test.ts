// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): the kill-guard builtin installs the runtime shims at session
// start and every agent shell environment (`getShellEnv`: PTY bash, core bash, monitors) carries them; the user's
// `terminal.killGuard: "off"` leaves the environment untouched. Nothing here runs a command.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { activateKillGuardRuntime, releaseKillGuardRuntime } from "../../src/core/kill-guard/runtime.ts";
import { type BashOperations, createBashTool } from "../../src/core/tools/bash.ts";
import { getShellEnv, getUserShellEnv } from "../../src/utils/shell.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const posix = process.platform !== "win32";

function builtin(id: string): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === id);
	if (!entry) throw new Error(`missing builtin extension: ${id}`);
	return entry.factory;
}

const harnesses: Harness[] = [];
const holders: object[] = [];
const directories: string[] = [];
afterEach(async () => {
	// Each session releases its own hold on shutdown, exactly as a host ends it.
	for (const harness of harnesses.splice(0)) {
		await emitSessionShutdownEvent(harness.getExtensionRunner(), { type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const holder of holders.splice(0)) releaseKillGuardRuntime(holder);
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function start(
	options: { userSettings?: unknown; projectSettings?: unknown } = {},
): Promise<{ agentDir: string; harness: Harness }> {
	const harness = await createHarness({ extensionFactories: [builtin("kill-guard")] });
	harnesses.push(harness);
	const agentDir = join(harness.tempDir, "agent");
	if (options.userSettings !== undefined) {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.userSettings));
	}
	if (options.projectSettings !== undefined) {
		mkdirSync(join(harness.tempDir, ".senpi"), { recursive: true });
		writeFileSync(join(harness.tempDir, ".senpi", "settings.json"), JSON.stringify(options.projectSettings));
	}
	await harness.session.bindExtensions({ uiContext: createTestUiContext() });
	return { agentDir, harness };
}

function agentDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-kill-guard-holder-"));
	directories.push(directory);
	return directory;
}

function hold(agentDir: string, holder: object = {}): object {
	holders.push(holder);
	activateKillGuardRuntime({ holder, agentDir, protectedPids: () => [1] });
	return holder;
}

const shimRoot = (agentDir: string) => `${join(agentDir, "kill-guard")}${sep}`;
const firstPathEntry = (env: NodeJS.ProcessEnv | undefined) => env?.PATH?.split(":")[0] ?? "";

describe.runIf(posix)("kill guard runtime layer delivery", () => {
	it("puts the shim directory first on PATH and exports BASH_ENV, the judge and the protected pids", async () => {
		const { agentDir } = await start();
		const env = getShellEnv();
		const dir = firstPathEntry(env);
		expect(dir.startsWith(shimRoot(agentDir))).toBe(true);
		for (const name of ["kill", "pkill", "killall", "bash_env.sh"]) expect(existsSync(join(dir, name))).toBe(true);
		expect(env.BASH_ENV).toBe(join(dir, "bash_env.sh"));
		expect(env.SENPI_KILL_GUARD_EXEC).toBe(process.execPath);
		expect(env.SENPI_KILL_GUARD_AGENT_PID).toBe(String(process.pid));
		expect(env.SENPI_KILL_GUARD_PROTECTED?.split(",")).toEqual(expect.arrayContaining(["1", String(process.pid)]));
	});

	it("installs and exports nothing while terminal.killGuard is off in user settings (C23)", async () => {
		const { agentDir } = await start({ userSettings: { terminal: { killGuard: "off" } } });
		const env = getShellEnv();
		expect(env.PATH?.includes(shimRoot(agentDir))).toBe(false);
		expect(env.BASH_ENV).toBe(process.env.BASH_ENV);
		expect(env.SENPI_KILL_GUARD_EXEC).toBe(process.env.SENPI_KILL_GUARD_EXEC);
		expect(existsSync(join(agentDir, "kill-guard"))).toBe(false);
	});

	it("ignores a project's attempt to switch the runtime layer off", async () => {
		const { agentDir } = await start({ projectSettings: { terminal: { killGuard: "off" } } });
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(agentDir))).toBe(true);
	});

	it("leaves a command the user types (`!cmd`) out of the runtime layer, while the agent's bash tool carries it", async () => {
		const { agentDir, harness } = await start();
		const envs: (NodeJS.ProcessEnv | undefined)[] = [];
		const operations: BashOperations = {
			exec: async (_command, _cwd, { env }) => {
				envs.push(env);
				return { exitCode: 0 };
			},
		};
		await harness.session.executeBash("true", undefined, { operations });
		await createBashTool(harness.tempDir, { operations }).execute("kill-guard-agent-bash", { command: "true" });
		const [user, agent] = envs;

		// Operations an extension returns from `user_bash` keep the contract they had before the guard: no env.
		expect(user).toBeUndefined();
		// The default operations get the user's shell env, which carries no runtime layer.
		const userEnv = getUserShellEnv();
		expect(userEnv.PATH?.includes(shimRoot(agentDir))).toBe(false);
		expect(userEnv.BASH_ENV).toBe(process.env.BASH_ENV);
		expect(userEnv.SENPI_KILL_GUARD_EXEC).toBe(process.env.SENPI_KILL_GUARD_EXEC);

		expect(firstPathEntry(agent).startsWith(shimRoot(agentDir))).toBe(true);
		expect(agent?.BASH_ENV).toBe(join(firstPathEntry(agent), "bash_env.sh"));
		expect(agent?.SENPI_KILL_GUARD_EXEC).toBe(process.execPath);
	});

	it("switching the guard off in one session leaves another session's layer in place", async () => {
		const { agentDir } = await start();
		await start({ userSettings: { terminal: { killGuard: "off" } } });
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(agentDir))).toBe(true);
	});

	it("keeps the remaining holder's layer when another holder releases it (two holders)", () => {
		const first = agentDirectory();
		const second = agentDirectory();
		const a = hold(first);
		const b = hold(second);
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(second))).toBe(true);

		releaseKillGuardRuntime(b);
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(first))).toBe(true);

		hold(second, b);
		releaseKillGuardRuntime(a);
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(second))).toBe(true);

		releaseKillGuardRuntime(b);
		expect(getShellEnv().BASH_ENV).toBe(process.env.BASH_ENV);
	});

	it("stops exporting once its last holder releases it, and never installs on Windows", () => {
		const agentDir = agentDirectory();
		const holder = hold(agentDir);
		expect(firstPathEntry(getShellEnv()).startsWith(shimRoot(agentDir))).toBe(true);
		releaseKillGuardRuntime(holder);
		expect(getShellEnv().PATH?.includes(shimRoot(agentDir))).toBe(false);

		const windows = activateKillGuardRuntime({ holder, agentDir, protectedPids: () => [1], platform: "win32" });
		expect(windows).toBeUndefined();
		expect(getShellEnv().PATH?.includes(shimRoot(agentDir))).toBe(false);
	});
});
