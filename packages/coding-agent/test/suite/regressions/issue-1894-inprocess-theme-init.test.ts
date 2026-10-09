import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createConnection, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { startFakeModelServer } from "../../helpers/rpc-fake-model.ts";
import { hermeticProviderEnv, MOCK_MODEL, MOCK_PROVIDER, writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder } from "../../helpers/spawned-host-reaper.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

/**
 * Regression (#1894): the socket (`--listen`) multi-session host runs every
 * session IN the host process (the in-process session runtime, #1796). The
 * worker split (75572fc90d) moved the worker's theme bootstrap into
 * session-worker.ts and dropped the host-side `initTheme()` that used to run
 * before `runMultiSessionHost()`, so extensions loading during
 * `open_session` on the in-process host read an uninitialized `theme` proxy
 * and failed with "Theme not initialized. Call initTheme() first." — surfaced
 * to embedders as `runtime.warning` rows.
 *
 * The sibling regression `0000-multi-session-theme-init.test.ts` covers the
 * worker runtime (spawned without `--listen`); this file covers the
 * in-process one. The probe extension touches the theme at module load time
 * and writes a marker file. Pre-fix the touch fails and the marker never
 * appears; post-fix the marker exists and neither the host transcript nor any
 * RPC record delivered over the socket contains the theme error.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testDir, "..", "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const senpiCli = path.join(packageDir, "src", "cli.ts");
const themeModule = path.join(packageDir, "src", "modes", "interactive", "theme", "theme.ts");

/**
 * A directly spawned host has no lifecycle supervisor, so any inherited
 * `*_RPC_HOST_*` watchdog binding (a launcher's supervisor pid, scratch dir,
 * cleanup paths) points at processes this child does not belong to and would
 * tear the host down mid-test. Scrub every lane, canonical and branded.
 */
function childEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/_RPC_HOST_/.test(key)) continue;
		if (value !== undefined) env[key] = value;
	}
	return {
		...env,
		...hermeticProviderEnv(),
		SENPI_RUNTIME: "node",
		NO_COLOR: "1",
	};
}

describe("in-process multi-session host initializes the interactive theme", () => {
	let child: ChildProcess | undefined;
	let socket: Socket | undefined;
	let tmp: string | undefined;

	afterEach(async () => {
		const host = child;
		child = undefined;
		socket?.destroy();
		socket = undefined;
		if (tmp) {
			// The socket host runs as a grandchild of the tsx wrapper this test spawned and
			// renames its own argv (process.title), so neither the child handle nor an
			// argv match finds it once the wrapper dies. reapProcessesUnder kills the
			// wrapper (its argv still names the socket path under tmp) and every
			// descendant with it - kill the wrapper first and the host is unreachable.
			// Reaping must run BEFORE the wrapper is killed, so no killAndWait here.
			await reapProcessesUnder(tmp);
			if (host && host.exitCode === null) host.kill("SIGKILL");
			fs.rmSync(tmp, { recursive: true, force: true });
		}
		tmp = undefined;
	});

	test("open_session on a socket host loads a theme-touching extension without crashing", async () => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senpi-theme-init-"));
		const agentDir = path.join(tmp, "agent");
		const extensionsDir = path.join(agentDir, "extensions");
		const sessionDir = path.join(tmp, "sessions");
		const workspace = path.join(tmp, "workspace");
		const socketPath = path.join(tmp, "rpc.sock");
		const marker = path.join(tmp, "theme-probe-loaded");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.mkdirSync(workspace, { recursive: true });

		const fake = await startFakeModelServer();
		writeRpcModelsJson(agentDir, fake.origin);
		fs.writeFileSync(
			path.join(extensionsDir, "theme-probe.ts"),
			[
				`import * as fs from "node:fs";`,
				`import { theme } from ${JSON.stringify(themeModule)};`,
				"// Touching the theme at extension load time is exactly what failed pre-fix.",
				`theme.fg("accent", "probe");`,
				`fs.writeFileSync(${JSON.stringify(marker)}, "loaded");`,
				"export default function themeProbe() {}",
			].join("\n"),
		);

		const spawned = spawn(
			process.execPath,
			[
				tsxCli,
				senpiCli,
				"--mode",
				"rpc",
				"--listen",
				`unix://${socketPath}`,
				"--session-runtime",
				"in-process",
				"--provider",
				MOCK_PROVIDER,
				"--model",
				MOCK_MODEL,
			],
			{
				cwd: workspace,
				env: {
					...childEnv(),
					SENPI_CODING_AGENT_DIR: agentDir,
					SENPI_CODING_AGENT_SESSION_DIR: sessionDir,
					PI_OFFLINE: "1",
					PI_TELEMETRY: "0",
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		child = spawned;

		let stdout = "";
		let stderr = "";
		spawned.stdout.on("data", (chunk: Buffer) => {
			stdout += String(chunk);
		});
		spawned.stderr.on("data", (chunk: Buffer) => {
			stderr += String(chunk);
		});

		await new Promise<void>((resolve, reject) => {
			const ready = `senpi rpc listening on unix://${socketPath}`;
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error(`host never announced readiness (${ready})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
			}, 180_000);
			const onData = () => {
				if (stderr.includes(ready)) {
					cleanup();
					resolve();
				}
			};
			const onExit = (code: number | null) => {
				cleanup();
				reject(new Error(`host exited before readiness (exit ${code})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
			};
			const cleanup = () => {
				clearTimeout(timer);
				spawned.stderr.off("data", onData);
				spawned.off("exit", onExit);
			};
			spawned.stderr.on("data", onData);
			spawned.once("exit", onExit);
		});

		socket = createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			socket!.once("connect", resolve);
			socket!.once("error", reject);
		});

		const lines: string[] = [];
		const response = new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => {
				detach();
				reject(
					new Error(
						`host never answered open_session\nstdout:\n${stdout}\nstderr:\n${stderr}\nrecords:\n${lines.join("\n")}`,
					),
				);
			}, 60_000);
			const detach = attachJsonlLineReader(socket!, (line) => {
				lines.push(line);
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(line) as Record<string, unknown>;
				} catch {
					return;
				}
				if (parsed.type === "response" && parsed.id === "open-1") {
					clearTimeout(timer);
					detach();
					resolve(parsed);
				}
			});
		});
		socket.write(`${JSON.stringify({ id: "open-1", type: "open_session", cwd: workspace })}\n`);
		await response;

		const transcript = `${stdout}\n${stderr}\n${lines.join("\n")}`;
		expect(transcript).not.toContain("Theme not initialized");
		expect(
			fs.existsSync(marker),
			`theme probe extension never loaded\nstdout:\n${stdout}\nstderr:\n${stderr}\nrecords:\n${lines.join("\n")}`,
		).toBe(true);
	}, 300_000);
});
