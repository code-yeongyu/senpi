// senpi#5349 / code-yeongyu/oh-my-openagent#12096 (L2): eval kernels (js, py, rb, jl) and every child they start get
// the kill guard's runtime layer through the session environment: the shim directory first on PATH, BASH_ENV and the
// judge exports. `terminal.killGuard: "off"` in user settings keeps them out. No kernel is started here.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { activateKillGuardRuntime, deactivateKillGuardRuntime } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime } from "../src/extension/runtime-factory.ts";
import type {
	CodemodeSessionManager,
	CreateCodemodeSessionManagerOptions,
} from "../src/extension/session-manager.ts";
import { fakeExtensionContext } from "./eval/fakes.ts";

const posix = process.platform !== "win32";
const directories: string[] = [];

afterEach(async () => {
	deactivateKillGuardRuntime();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const inertManager: CodemodeSessionManager = {
	getKernel: async () => {
		throw new Error("no kernel in this test");
	},
	dispose: async () => {},
	complete: async () => ({ text: "", details: { model: "fake/fake", structured: false } }),
};

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.push(directory);
	return directory;
}

async function kernelSessionEnv(agentDir: string): Promise<Readonly<Record<string, string>> | undefined> {
	const cwd = await temporaryDirectory("senpi-kill-guard-kernel-cwd-");
	let captured: CreateCodemodeSessionManagerOptions | undefined;
	const base = fakeExtensionContext();
	await createRuntime(
		{
			getActiveTools: () => ["eval"],
			getAllTools: () => [{ name: "eval" }],
			executeTool: async () => {
				throw new Error("no tools in this test");
			},
		},
		{
			...base,
			cwd,
			agentDir,
			sessionManager: { ...base.sessionManager, getSessionId: () => "kill-guard", getSessionFile: () => undefined },
		},
		{ sessionId: "kill-guard" },
		async () => ({ text: "", details: { model: "fake/fake", structured: false } }),
		{
			createSessionManager: (options) => {
				captured = options;
				return inertManager;
			},
		},
	);
	return captured?.sessionEnv;
}

describe.runIf(posix)("kernel session environment and the kill guard's runtime layer", () => {
	it("hands kernels the shim PATH entry, BASH_ENV and the judge exports while the guard is on", async () => {
		const agentDir = await temporaryDirectory("senpi-kill-guard-kernel-agent-");
		const runtime = activateKillGuardRuntime({ holder: {}, agentDir, protectedPids: () => [1, process.pid] });
		expect(runtime).toBeDefined();
		const env = await kernelSessionEnv(agentDir);
		expect(env?.PATH?.split(delimiter)[0]).toBe(runtime?.dir);
		expect(env?.BASH_ENV).toBe(runtime?.bashEnv);
		expect(env?.SENPI_KILL_GUARD_EXEC).toBe(process.execPath);
		expect(env?.SENPI_KILL_GUARD_AGENT_PID).toBe(String(process.pid));
		expect(env?.SENPI_KILL_GUARD_PROTECTED).toBe(`1,${process.pid}`);
	});

	it("keeps the runtime layer out of kernels while terminal.killGuard is off in user settings (C23)", async () => {
		const agentDir = await temporaryDirectory("senpi-kill-guard-kernel-off-");
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ terminal: { killGuard: "off" } }));
		const runtime = activateKillGuardRuntime({ holder: {}, agentDir, protectedPids: () => [1] });
		const env = await kernelSessionEnv(agentDir);
		expect(env?.BASH_ENV).toBeUndefined();
		expect(env?.SENPI_KILL_GUARD_EXEC).toBeUndefined();
		expect(runtime).toBeDefined();
		expect(env?.PATH?.split(delimiter) ?? []).not.toContain(runtime?.dir);
	});

	it("adds nothing when no host activated the runtime layer", async () => {
		const agentDir = await temporaryDirectory("senpi-kill-guard-kernel-none-");
		const env = await kernelSessionEnv(agentDir);
		expect(env?.BASH_ENV).toBeUndefined();
		expect(env?.SENPI_KILL_GUARD_EXEC).toBeUndefined();
	});
});
