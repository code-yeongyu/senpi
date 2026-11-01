// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): the kill-guard builtin installs the runtime shims at session
// start and every agent shell environment (`getShellEnv`: PTY bash, core bash, monitors) carries them; the user's
// `terminal.killGuard: "off"` leaves the environment untouched. Nothing here runs a command.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import {
	activateKillGuardRuntime,
	deactivateKillGuardRuntime,
	releaseKillGuardRuntime,
} from "../../src/core/kill-guard/runtime.ts";
import { getShellEnv } from "../../src/utils/shell.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

const posix = process.platform !== "win32";

function builtin(id: string): ExtensionFactory {
	const entry = builtinExtensions.find((extension) => extension.id === id);
	if (!entry) throw new Error(`missing builtin extension: ${id}`);
	return entry.factory;
}

const harnesses: Harness[] = [];
const directories: string[] = [];
afterEach(() => {
	deactivateKillGuardRuntime();
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
	while (directories.length > 0) rmSync(directories.pop() ?? "", { recursive: true, force: true });
});

async function start(options: { userSettings?: unknown; projectSettings?: unknown } = {}): Promise<string> {
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
	return agentDir;
}

const shimRoot = (agentDir: string) => `${join(agentDir, "kill-guard")}${sep}`;

describe.runIf(posix)("kill guard runtime layer delivery", () => {
	it("puts the shim directory first on PATH and exports BASH_ENV, the judge and the protected pids", async () => {
		const agentDir = await start();
		const env = getShellEnv();
		const dir = env.PATH?.split(":")[0] ?? "";
		expect(dir.startsWith(shimRoot(agentDir))).toBe(true);
		for (const name of ["kill", "pkill", "killall", "bash_env.sh"]) expect(existsSync(join(dir, name))).toBe(true);
		expect(env.BASH_ENV).toBe(join(dir, "bash_env.sh"));
		expect(env.SENPI_KILL_GUARD_EXEC).toBe(process.execPath);
		expect(env.SENPI_KILL_GUARD_AGENT_PID).toBe(String(process.pid));
		expect(env.SENPI_KILL_GUARD_PROTECTED?.split(",")).toEqual(expect.arrayContaining(["1", String(process.pid)]));
	});

	it("installs and exports nothing while terminal.killGuard is off in user settings (C23)", async () => {
		const agentDir = await start({ userSettings: { terminal: { killGuard: "off" } } });
		const env = getShellEnv();
		expect(env.PATH?.includes(shimRoot(agentDir))).toBe(false);
		expect(env.BASH_ENV).toBe(process.env.BASH_ENV);
		expect(env.SENPI_KILL_GUARD_EXEC).toBe(process.env.SENPI_KILL_GUARD_EXEC);
		expect(existsSync(join(agentDir, "kill-guard"))).toBe(false);
	});

	it("ignores a project's attempt to switch the runtime layer off", async () => {
		const agentDir = await start({ projectSettings: { terminal: { killGuard: "off" } } });
		expect(getShellEnv().PATH?.split(":")[0]?.startsWith(shimRoot(agentDir))).toBe(true);
	});

	it("stops exporting once its last holder releases it, and never installs on Windows", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-kill-guard-holder-"));
		directories.push(agentDir);
		const holder = {};
		activateKillGuardRuntime({ holder, agentDir, protectedPids: () => [1] });
		expect(getShellEnv().PATH?.startsWith(shimRoot(agentDir))).toBe(true);
		releaseKillGuardRuntime(holder);
		expect(getShellEnv().PATH?.includes(shimRoot(agentDir))).toBe(false);

		const windows = activateKillGuardRuntime({ holder, agentDir, protectedPids: () => [1], platform: "win32" });
		expect(windows).toBeUndefined();
		expect(getShellEnv().PATH?.includes(shimRoot(agentDir))).toBe(false);
	});
});
