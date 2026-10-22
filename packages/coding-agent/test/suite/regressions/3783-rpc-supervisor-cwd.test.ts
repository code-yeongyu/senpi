import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { terminateProcessTrees } from "../../../../senpi-codemode/src/kernels/js/process-tree-host.ts";
import { hermeticProviderEnv } from "../../helpers/rpc-hermetic.ts";

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/3783
function processCwd(pid: number): string {
	if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
	const fields = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
	const name = fields.split("\n").find((line) => line.startsWith("n"));
	if (name === undefined) throw new Error(`no cwd reported for ${pid}`);
	return name.slice(1);
}

describe.skipIf(process.platform === "win32")("RPC host supervisor cwd", () => {
	const created: string[] = [];
	afterEach(() => {
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	const tsx = import.meta.resolve("tsx");

	/** Starts `host-lifecycle.ts` DIRECTLY (no ensureHost behind it) from `caller`, runs `check` once it is ready. */
	async function withDirectSupervisor(
		caller: string,
		agentDir: string,
		args: readonly string[],
		check: (supervisor: ChildProcess) => void,
		options: { readonly execArgv?: readonly string[]; readonly env?: NodeJS.ProcessEnv } = {},
	): Promise<void> {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			...options.env,
			...hermeticProviderEnv(),
			PI_OFFLINE: "1",
			OMO_CODING_AGENT_DIR: agentDir,
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_RPC_HOST_COLD_START: "persistent",
		};
		delete env.OMO_RPC_SOCKET_PATH;
		delete env.SENPI_RPC_SOCKET_PATH;
		const supervisor = spawn(
			process.execPath,
			[
				"--import",
				tsx,
				...(options.execArgv ?? []),
				resolve(import.meta.dirname, "../../../src/modes/rpc/host-lifecycle.ts"),
				...args,
			],
			{ cwd: caller, env, stdio: ["ignore", "ignore", "pipe"] },
		);
		const exited = once(supervisor, "exit");
		const stderr = createInterface({ input: supervisor.stderr });
		const ready = (async () => {
			let output = "";
			for await (const line of stderr) {
				output = `${output}${line}\n`.slice(-16_000);
				if (line.includes("senpi rpc host ready on ")) return;
			}
			throw new Error(`supervisor exited before readiness:\n${output}`);
		})();
		try {
			await ready;
			check(supervisor);
		} finally {
			try {
				if (supervisor.pid !== undefined) {
					await terminateProcessTrees([supervisor.pid], { ownerPid: process.pid, graceMs: 1000 });
				}
				await exited;
			} finally {
				stderr.close();
			}
		}
	}

	function tempLayout(): { root: string; caller: string; agentDir: string } {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "rpc3783-")));
		created.push(root);
		const caller = join(root, "caller-worktree");
		mkdirSync(caller);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir);
		return { root, caller, agentDir };
	}

	it("leaves the caller's directory for its agent dir and spawns the host child there", async () => {
		const { root, caller, agentDir } = tempLayout();
		const childCwdReport = join(root, "child-cwd");
		const childArgs = ["--import", tsx, resolve(import.meta.dirname, "../../fixtures/rpc-cwd-reporting-child.ts")];
		await withDirectSupervisor(
			caller,
			agentDir,
			[
				"--socket",
				join(root, "rpc.sock"),
				"--agent-dir",
				agentDir,
				"--child-command",
				process.execPath,
				"--child-args",
				JSON.stringify([...childArgs, childCwdReport]),
			],
			(supervisor) => {
				const expected = realpathSync(agentDir);
				if (supervisor.pid === undefined) throw new Error("supervisor has no pid");
				expect(realpathSync(processCwd(supervisor.pid))).toBe(expected);
				expect(realpathSync(readFileSync(childCwdReport, "utf8"))).toBe(expected);
			},
		);
	}, 45_000);

	// Review round 3: a DIRECT launch (no ensureHost/handoffHost to absolutize first) still reads relative path-valued
	// host args against the directory it was started from, the CLI's `resolveCliPaths` rule, never against the agent dir.
	it("resolves a direct launch's relative --session-dir and -e against the inherited cwd", async () => {
		const { root, caller, agentDir } = tempLayout();
		writeFileSync(join(caller, "ext.ts"), "export default function () {}\n");
		const argvReport = join(root, "child-argv.json");
		await withDirectSupervisor(
			caller,
			agentDir,
			[
				"--socket",
				join(root, "rpc.sock"),
				"--agent-dir",
				agentDir,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--session-dir",
				"sessions",
				"-e",
				"./ext.ts",
			],
			() => {
				const argv: string[] = JSON.parse(readFileSync(argvReport, "utf8"));
				expect(argv[argv.indexOf("--session-dir") + 1]).toBe(join(caller, "sessions"));
				expect(argv[argv.indexOf("-e") + 1]).toBe(join(caller, "ext.ts"));
			},
			{
				execArgv: ["--import", resolve(import.meta.dirname, "../../fixtures/rpc-host-argv-recorder.mjs")],
				env: { RPC_HOST_ARGV_REPORT: argvReport },
			},
		);
	}, 60_000);
});
