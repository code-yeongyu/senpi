#!/usr/bin/env node
/**
 * Live QA for `senpi host`: the REAL CLI, from source, against a sandbox agent directory.
 *
 * Nothing here calls the engine in-process - every step spawns the command a client would spawn and
 * reads what it printed, so the evidence quotes the process contract (one JSON line, an exit code)
 * rather than a claim about it. One JSON line per step, written synchronously, so a step that hangs
 * has still printed every step before it.
 *
 * Usage: bun scripts/qa-rpc-socket/host-cli.mjs [--keep]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "..", "src", "cli.ts");
const keep = process.argv.includes("--keep");
const root = mkdtempSync(join(tmpdir(), "hq-"));
const agentDir = join(root, "a");
const specDir = join(root, "spec");
const socket = join(root, "r.sock");
for (const dir of [agentDir, specDir]) mkdirSync(dir, { recursive: true });
const say = (step, data) => writeFileSync(1, `${JSON.stringify({ step, ...data })}\n`);

writeFileSync(join(specDir, "probe.js"), "export default function probe() {}\n");
writeFileSync(
	join(specDir, "launch.json"),
	`${JSON.stringify({
		spec_version: 1,
		core: { session_runtime: "in-process", multi_session: true, extensions: ["probe.js"] },
		tunables: { idleExitMs: 600_000, coldStart: "transient" },
		env: { SENPI_QA_HOST_CLI: "1" },
	})}\n`,
	{ mode: 0o600 },
);
const spec = join(specDir, "launch.json");

try {
	const started = await host(["ensure", "--json", "--launch-spec", spec], { MY_SECRET_TOKEN: "canary-value" });
	say("ensure", { exitCode: started.exitCode, action: started.json?.action, pid: started.json?.pid });

	const reused = await host(["ensure", "--json", "--launch-spec", spec]);
	say("ensure-again", {
		exitCode: reused.exitCode,
		action: reused.json?.action,
		sameInstance: reused.json?.instanceId === started.json?.instanceId,
	});

	const status = await host(["status", "--json"]);
	say("status", {
		exitCode: status.exitCode,
		reachable: status.json?.reachable,
		sessions: status.json?.sessions,
		rss_mb: status.json?.rss_mb,
		zombies: status.json?.zombies,
		extensions: status.json?.launchProfile?.core?.extensions,
		specEnvGranted: status.json?.env_keys?.includes("SENPI_QA_HOST_CLI"),
		canaryGranted: status.json?.env_keys?.includes("MY_SECRET_TOKEN"),
		generations: status.json?.generations?.length,
	});

	const evil = join(specDir, "evil.json");
	writeFileSync(
		evil,
		`${JSON.stringify({
			spec_version: 1,
			core: { session_runtime: "in-process", multi_session: true, extensions: ["../evil.js"] },
		})}\n`,
		{ mode: 0o600 },
	);
	const escaped = await host(["ensure", "--json", "--launch-spec", evil]);
	say("path-escape", { exitCode: escaped.exitCode, reason: escaped.json?.reason });

	const usage = await host(["frob"]);
	say("usage", { exitCode: usage.exitCode, stdout: usage.stdout, usageOnStderr: usage.stderr.includes("usage:") });

	const stopped = await host(["stop", "--json"]);
	say("stop", { exitCode: stopped.exitCode, action: stopped.json?.action, sessions: stopped.json?.sessions });

	const after = await host(["status", "--json"]);
	say("status-after-stop", { exitCode: after.exitCode, reachable: after.json?.reachable, socket: existsSync(socket) });
} finally {
	if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 10 });
	say("cleanup", { root, kept: keep });
}

function host(args, extraEnv = {}) {
	const child = spawn(process.execPath, [cli, "host", ...args, "--socket", socket], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
			SENPI_CODING_AGENT_DIR: agentDir,
			SENPI_RUNTIME: "bun",
			PI_OFFLINE: "1",
			PI_TELEMETRY: "0",
			...extraEnv,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
	child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode) => {
			const line = stdout.split("\n").find((entry) => entry.length > 0);
			resolve({ exitCode, stdout, stderr, json: line ? JSON.parse(line) : undefined });
		});
	});
}
