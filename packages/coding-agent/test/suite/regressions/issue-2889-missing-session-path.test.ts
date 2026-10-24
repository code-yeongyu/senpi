// Regression for #2889: a --session, --fork or --rebind path that names no file is reported, never opened as a new session.
import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createSessionManager } from "../../../src/main.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../../../src/experimental/source-resolver.ts")).href;
const fixture = resolve(__dirname, "../../fixtures/before-compaction.jsonl");
const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	// A case that times out leaves its CLI running together with the cli-main child it re-launched. Both
	// overwrite their command line with process.title, so neither can be found by path: kill the CLI's
	// process group, then wait for the stderr pipe they share to close, which happens once both have exited.
	for (const child of children.splice(0)) {
		if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue;
		const closed = once(child, "close");
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		}
		await closed;
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	// realpath: on macOS tmpdir() is a symlink, and the spawned CLI resolves paths physically.
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-2889-")));
	tempDirs.push(dir);
	return dir;
}

function listFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	// Even if the path check regressed and a case went on to prompt, no real provider could answer: provider
	// credentials are blanked and the model is a local stand-in whose endpoint refuses connections.
	writeRpcModelsJson(agentDir, "http://127.0.0.1:1");
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(
			process.execPath,
			["--import", sourceResolverUrl, cliPath, "--provider", MOCK_PROVIDER, "--model", MOCK_MODEL, ...args],
			{
				cwd,
				detached: process.platform !== "win32",
				env: { ...process.env, ...hermeticProviderEnv(), [ENV_AGENT_DIR]: agentDir, PI_OFFLINE: "1" },
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		children.push(child);
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});
	return { code, stderr };
}

describe("missing session path (#2889)", () => {
	it.each([
		["--session in print mode", (path: string) => ["--session", path, "-p", "hi"]],
		["--session in RPC mode", (path: string) => ["--session", path, "--mode", "rpc"]],
		["--fork", (path: string) => ["--fork", path, "-p", "hi"]],
		["--rebind", (path: string) => ["--rebind", path, "-p", "hi"]],
	] as const)(
		"reports a path that names no file and starts no session: %s",
		async (_label, argsFor) => {
			const root = createTempDir();
			const agentDir = join(root, "agent");
			const projectDir = join(root, "project");
			mkdirSync(agentDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			const missing = join(root, "sessions", "typo-does-not-exist.jsonl");

			const result = await runCli(argsFor(missing), projectDir, agentDir);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`No session file at ${missing}`);
			expect(existsSync(missing)).toBe(false);
			expect(listFiles(join(root, "sessions"))).toEqual([]);
			expect(listFiles(join(agentDir, "sessions"))).toEqual([]);
		},
		60_000,
	);

	it("still opens an existing session file given by path", async () => {
		const root = createTempDir();
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		const sessionFile = join(root, "existing.jsonl");
		copyFileSync(fixture, sessionFile);
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]) as { id: string };

		const manager = await createSessionManager(
			parseArgs(["--session", sessionFile]),
			projectDir,
			undefined,
			SettingsManager.inMemory(),
			"print",
		);

		expect(manager.getSessionFile()).toBe(sessionFile);
		expect(manager.getSessionId()).toBe(header.id);
	});
});
