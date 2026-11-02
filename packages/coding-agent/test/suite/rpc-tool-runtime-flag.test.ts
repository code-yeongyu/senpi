/**
 * `--tool-runtime in-process|child` (senpi#3566): the flag, its `SENPI_TOOL_RUNTIME` fallback, the
 * startup error for an unknown value, and the `tool_runtime:<value>` capability a real host
 * advertises. Guards a CLI flag + protocol capability contract that later clients negotiate on.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { resolveToolRuntime } from "../../src/cli/tool-runtime.ts";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { stopHost } from "../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	generationScratch,
	JsonlPeer,
	reapProcessesUnder,
	supervisorLaunch,
	waitForPidGone,
} from "../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../helpers/rpc-hermetic.ts";
import { assertWorkspaceBuildPrerequisite } from "../support/workspace-build-prerequisite.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(import.meta.dirname, "../../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
}, 120_000);

describe("resolveToolRuntime", () => {
	it("defaults to in-process with neither the flag nor the env set", () => {
		expect(resolveToolRuntime(parseArgs([]), {})).toEqual({ ok: true, value: "in-process" });
	});

	it("takes the flag, then the env, and the flag beats the env", () => {
		expect(resolveToolRuntime(parseArgs(["--tool-runtime", "child"]), {})).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime(parseArgs([]), { SENPI_TOOL_RUNTIME: "child" })).toEqual({ ok: true, value: "child" });
		expect(resolveToolRuntime(parseArgs(["--tool-runtime", "in-process"]), { SENPI_TOOL_RUNTIME: "child" })).toEqual({
			ok: true,
			value: "in-process",
		});
	});

	it("rejects an unknown value from either source, naming both kinds", () => {
		const parsed = parseArgs(["--tool-runtime", "bogus"]);
		expect(parsed.toolRuntime).toBeUndefined();
		expect(parsed.diagnostics).toContainEqual({
			type: "error",
			message: "--tool-runtime must be in-process or child",
		});
		const fromEnv = resolveToolRuntime(parseArgs([]), { SENPI_TOOL_RUNTIME: "bogus" });
		expect(fromEnv.ok).toBe(false);
		expect(fromEnv.ok ? "" : fromEnv.message).toMatch(/^SENPI_TOOL_RUNTIME .*in-process or child/);
		const fromLegacy = resolveToolRuntime(parseArgs([]), { PI_TOOL_RUNTIME: "bogus" });
		expect(fromLegacy.ok ? "" : fromLegacy.message).toMatch(/^PI_TOOL_RUNTIME /);
	});
});

describe("tool runtime at startup", () => {
	it("lets --version through a bad tool-runtime env value", async () => {
		const version = await runCli(["--version"], { SENPI_TOOL_RUNTIME: "bogus" });
		expect(version.code).toBe(0);
		expect(version.stderr).not.toContain("tool-runtime");
	}, 60_000);

	it("rejects an unknown tool runtime and exits non-zero before serving", async () => {
		const flag = await runCli(["--mode", "rpc", "--multi-session", "--tool-runtime", "bogus"], {});
		expect(flag.code).not.toBe(0);
		expect(flag.stderr).toContain("--tool-runtime must be in-process or child");
		const env = await runCli(["--mode", "rpc", "--multi-session"], { SENPI_TOOL_RUNTIME: "bogus" });
		expect(env.code).not.toBe(0);
		expect(env.stderr).toContain("tool-runtime");
		expect(env.stderr).toContain("in-process or child");
	}, 60_000);

	it("a single-session --mode rpc process advertises tool_runtime:child", async () => {
		const scratch = generationScratch("toolrt-classic");
		cleanups.push(() => rm(scratch.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
		writeRpcModelsJson(scratch.agentDir, "http://127.0.0.1:1");
		const child = spawn(
			process.execPath,
			["--import", sourceResolverUrl, cliPath, "--mode", "rpc", ...GENERATION_HOST_ARGS, "--tool-runtime", "child"],
			{
				cwd: scratch.cwd,
				env: { ...hostSpawnEnv(), ...generationEnv(scratch), SENPI_CODING_AGENT_DIR: scratch.agentDir },
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const exited = once(child, "exit");
		cleanups.push(async () => {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exited;
		});
		const answer = new Promise<Record<string, unknown>>((resolveAnswer, reject) => {
			let buffer = "";
			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				for (const line of buffer.split("\n").slice(0, -1)) {
					const record = JSON.parse(line) as Record<string, unknown>;
					if (record.id === "info") resolveAnswer(record);
				}
				buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
			});
			void exited.then(([code]) => reject(new Error(`rpc process exited ${code} before answering`)));
		});
		child.stdin.write(`${JSON.stringify({ id: "info", type: "get_protocol_info" })}\n`);
		const info = await answer;
		const capabilities = (info.data as { capabilities?: unknown } | undefined)?.capabilities;
		expect(
			Array.isArray(capabilities) ? capabilities.filter((c) => String(c).startsWith("tool_runtime:")) : [],
		).toEqual(["tool_runtime:child"]);
	}, 120_000);

	it.each([
		{ hostArgs: [], expected: "tool_runtime:in-process" },
		{ hostArgs: ["--tool-runtime", "child"], expected: "tool_runtime:child" },
	])(
		"ensureHost advertises tool_runtime ($expected)",
		async ({ hostArgs, expected }) => {
			const qa = generationScratch("toolrt");
			const peers: JsonlPeer[] = [];
			cleanups.push(async () => {
				for (const peer of peers) peer.destroy();
				try {
					const stopped = await stopHost({ socket: qa.socket, agentDir: qa.agentDir, force: true });
					if (stopped.action === "stopped" && !(await waitForPidGone(stopped.pid, 30_000)))
						throw new Error(`host ${stopped.pid} did not exit`);
				} finally {
					await reapProcessesUnder(qa.root);
				}
				await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
			});
			writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
			const host = await ensureHost({
				socket: qa.socket,
				agentDir: qa.agentDir,
				hostArgs: [...GENERATION_HOST_ARGS, ...hostArgs],
				env: generationEnv(qa),
				policy: { idleExitMs: 600_000 },
				_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
			});
			host.release();
			const toolRuntimeEntries = async (peer: JsonlPeer, id: string) => {
				const info = await peer.request({ id, type: "get_protocol_info" });
				const capabilities = (info.data as { capabilities?: unknown } | undefined)?.capabilities;
				return Array.isArray(capabilities) ? capabilities.filter((c) => String(c).startsWith("tool_runtime:")) : [];
			};
			const first = await JsonlPeer.connect(qa.socket);
			peers.push(first);
			expect(await toolRuntimeEntries(first, "first")).toEqual([expected]);
			const concurrent = await JsonlPeer.connect(qa.socket);
			peers.push(concurrent);
			expect(await toolRuntimeEntries(concurrent, "second-connection")).toEqual([expected]);
			first.destroy();
			const reconnected = await JsonlPeer.connect(qa.socket);
			peers.push(reconnected);
			expect(await toolRuntimeEntries(reconnected, "after-reconnect")).toEqual([expected]);
		},
		120_000,
	);
});

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolvePromise, reject) => {
		const scratch = generationScratch("toolrt-cli");
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd: scratch.cwd,
			env: { ...hostSpawnEnv(), ...generationEnv(scratch), SENPI_CODING_AGENT_DIR: scratch.agentDir, ...env },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (code) => {
			void rm(scratch.root, { recursive: true, force: true }).then(() => resolvePromise({ code, stderr }), reject);
		});
	});
}
