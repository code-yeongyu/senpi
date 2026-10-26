import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const resolver = new URL("../../src/experimental/source-resolver.ts", import.meta.url).href;
const roots: string[] = [];
const ancestry = { parentSessionId: "parent", rootSessionId: "root", taskId: "task" };

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-spawned-by-")));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sessions = join(root, "sessions");
	mkdirSync(agentDir);
	writeRpcModelsJson(agentDir, "http://127.0.0.1:1");
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
	return { root, agentDir, sessions };
}

async function runCli(dirs: ReturnType<typeof setup>, args: string[], requestState = true) {
	const child = spawn(
		process.execPath,
		[
			"--import",
			resolver,
			cli,
			"--mode",
			"rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--no-prompt-templates",
			"--no-themes",
			"--session-dir",
			dirs.sessions,
			"--provider",
			MOCK_PROVIDER,
			"--model",
			MOCK_MODEL,
			...args,
		],
		{
			cwd: dirs.root,
			env: {
				PATH: process.env.PATH,
				HOME: dirs.root,
				USERPROFILE: dirs.root,
				TMPDIR: process.env.TMPDIR,
				SENPI_CODING_AGENT_DIR: dirs.agentDir,
				SENPI_CODING_AGENT_SESSION_DIR: dirs.sessions,
				SENPI_RUNTIME: "node",
				PI_OFFLINE: "1",
				PI_SKIP_RUNTIME_NOTICE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = once(child, "close");
	const lines = createInterface({ input: child.stdout });
	const response = new Promise<Record<string, unknown>>((resolve, reject) => {
		lines.on("line", (line) => {
			const record = JSON.parse(line);
			if (record.type === "response" && record.id === "state") resolve(record);
		});
		child.once("close", (code) => reject(new Error(`CLI exited ${code} before get_state: ${stderr}`)));
		child.once("error", reject);
	});
	// Subscribe before asking: no prompt or model request is ever sent.
	const deadline = AbortSignal.timeout(30_000);
	const bounded = Promise.race([
		response,
		new Promise<never>((_, reject) => {
			deadline.addEventListener("abort", () => reject(new Error(`CLI deadline: ${stderr}`)), { once: true });
		}),
	]);
	// A malformed run should exit without answering. Observe its rejection too.
	void bounded.catch(() => {});
	try {
		if (requestState) {
			child.stdin.write('{"id":"state","type":"get_state"}\n');
			const state = await bounded;
			return { state, stderr, code: undefined };
		}
		child.stdin.end();
		const [code] = await exited;
		return { state: undefined, stderr, code };
	} finally {
		lines.close();
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		await exited;
	}
}

// oh-my-openagent#10782: prove ancestry through real standalone CLI startup, before any prompt.
describe("standalone CLI ancestry", () => {
	it.each([false, true])("starts a fresh child with a durable header (explicit id: %s)", async (explicitId) => {
		const dirs = setup();
		const result = await runCli(dirs, [
			"--spawned-by",
			JSON.stringify(ancestry),
			...(explicitId ? ["--session-id", "fresh-child"] : []),
		]);
		expect(result.state).toMatchObject({
			success: true,
			data: { lifecycle: { role: "child", ...ancestry } },
		});
		const data = result.state?.data;
		if (typeof data !== "object" || data === null || !("sessionFile" in data) || typeof data.sessionFile !== "string")
			throw new Error("get_state did not return a session file");
		const header = JSON.parse(readFileSync(data.sessionFile, "utf8").split("\n")[0]);
		expect(header.spawnedBy).toEqual(ancestry);
	});

	it("rejects malformed input before runtime or session storage is created", async () => {
		const dirs = setup();
		const result = await runCli(dirs, ["--spawned-by", '{"parentSessionId":1}'], false);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("--spawned-by");
		expect(existsSync(dirs.sessions)).toBe(false);
		expect(existsSync(join(dirs.agentDir, "rpc"))).toBe(false);
	});

	it.each(["--session", "--session-id"])("keeps resumed ancestry unchanged with %s", async (selector) => {
		const dirs = setup();
		const existing = { parentSessionId: "original-parent", rootSessionId: "original-root", taskId: "original-task" };
		const manager = SessionManager.create(dirs.root, dirs.sessions, { id: "existing", spawnedBy: existing });
		await manager.persistHeaderNow();
		const path = manager.getSessionFile();
		if (!path) throw new Error("Missing fixture session path");
		manager.dispose();
		const result = await runCli(dirs, [
			selector,
			selector === "--session" ? path : "existing",
			"--spawned-by",
			JSON.stringify(ancestry),
		]);
		expect(result.state).toMatchObject({ data: { lifecycle: { role: "child", ...existing } } });
		expect(JSON.parse(readFileSync(path, "utf8").split("\n")[0]).spawnedBy).toEqual(existing);
		expect(result.stderr).toContain("Warning:");
	});

	it.each([false, true])("keeps ordinary sessions root (fork: %s)", async (fork) => {
		const dirs = setup();
		const source = SessionManager.create(dirs.root, dirs.sessions, { spawnedBy: ancestry });
		await source.persistHeaderNow();
		const path = source.getSessionFile();
		if (!path) throw new Error("Missing fixture session path");
		source.dispose();
		const result = await runCli(dirs, fork ? ["--fork", path] : []);
		expect(result.state).toMatchObject({ success: true, data: { lifecycle: { role: "root" } } });
	});
});
