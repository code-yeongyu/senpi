// senpi#3711: a quit that ends the process must exit within the quit budget even when a session_shutdown handler
// never settles. Drives the real CLI in RPC mode, which quits when its stdin ends and then calls process.exit.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticProviderEnv } from "../../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = fileURLToPath(new URL("../../../src/cli.ts", import.meta.url));
const QUIT_BUDGET_MS = 300;
const HANDLER_CAP_MS = 10_000;
// Generous for a loaded CI host, still far below the 10 s per-handler cap the process used to wait out.
const EXIT_BOUND_MS = 5_000;

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface QuitRun {
	readonly exitCode: number | null;
	readonly quitToExitMs: number;
}

function quitRpcWithHungHandler(): Promise<QuitRun> {
	const root = mkdtempSync(join(tmpdir(), "senpi-3711-exit-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const extensionPath = join(root, "hung-shutdown.ts");
	writeFileSync(
		extensionPath,
		'export default function (pi: any) {\n\tpi.on("session_shutdown", () => new Promise<void>(() => {}));\n}\n',
	);
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ sessionShutdownQuitBudgetMs: QUIT_BUDGET_MS, sessionShutdownHandlerTimeoutMs: HANDLER_CAP_MS }),
	);
	const child = spawn("node", [cliPath, "--mode", "rpc", "--no-session", "-e", extensionPath], {
		cwd: root,
		env: {
			...hostSpawnEnv(),
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			SENPI_RUNTIME: "node",
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	return new Promise<QuitRun>((resolve, reject) => {
		let quitAt: number | undefined;
		let stdout = "";
		child.on("error", reject);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			// The first response proves the session is bound and its extensions loaded; then quit.
			if (quitAt === undefined && stdout.includes('"type":"response"')) {
				quitAt = performance.now();
				child.stdin.end();
			}
		});
		child.on("exit", (exitCode) => {
			if (quitAt === undefined) {
				reject(new Error(`rpc child exited (${exitCode}) before answering get_state: ${stdout.slice(-500)}`));
				return;
			}
			resolve({ exitCode, quitToExitMs: performance.now() - quitAt });
		});
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
	});
}

describe("senpi#3711 quit ends the process within the quit budget", () => {
	it(
		"exits an RPC process whose session_shutdown handler never settles",
		async () => {
			const run = await quitRpcWithHungHandler();

			expect(run.exitCode).toBe(0);
			expect(run.quitToExitMs).toBeLessThan(EXIT_BOUND_MS);
		},
		HANDLER_CAP_MS + 20_000,
	);
});
