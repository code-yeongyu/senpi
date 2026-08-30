#!/usr/bin/env node
/**
 * Real-binary QA for the shared interactive host under a bun-compiled
 * standalone executable (`npm run build:binary` -> dist/pi).
 *
 * A compiled binary cannot re-enter itself through a script path: bun
 * standalone executables always boot their embedded entrypoint, so a
 * `host-lifecycle.ts --socket <path>` argv is parsed as CLI arguments and the
 * spawned host dies with "Unknown option: --socket" before it ever answers
 * `get_protocol_info`. This driver proves the full compiled chain end to end:
 *
 *   compiled TUI (pty) -> ensureHost() -> `--internal-rpc-host-supervisor`
 *     -> supervisor -> compiled `--mode rpc --multi-session --listen` host
 *
 * PASS: the public socket answers get_protocol_info with the running VERSION
 * and the required capabilities while the compiled TUI is attached, and the
 * pty transcript never shows the shared-host fallback warning.
 * FAIL: the fallback warning appears (the supervisor stderr log is captured
 * into the transcript for diagnosis) or the socket never answers.
 *
 * Usage: compiled-host.mjs --binary <path-to-compiled-binary> [--out <file>]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { createHostDaemonPaths } from "../../src/modes/rpc/host-ensure.ts";
import {
	cleanupAllAndWait,
	installCleanupHooks,
	makeScratch,
	startFakeModelServer,
	writeMockModelsJson,
} from "../qa-app-server/lib/env.mjs";
import { trackChild } from "../qa-app-server/lib/cleanup.mjs";

const FALLBACK_NEEDLE = "shared interactive host unavailable";
const READY_BUDGET_MS = 30_000;

const transcript = [];
const binaryPath = flag("--binary") === undefined ? undefined : resolve(flag("--binary"));
const outPath = flag("--out");
installCleanupHooks();

async function main() {
	let scratch;
	let fake;
	let tui;
	let output = "";
	let supervisorStopped = false;
	try {
		if (!binaryPath || !existsSync(binaryPath)) {
			throw new Error(`--binary must name an existing compiled binary (got: ${binaryPath ?? "<missing>"})`);
		}
		scratch = makeScratch("cbin");
		fake = await startFakeModelServer([{ text: "compiled-host-qa" }]);
		writeMockModelsJson(scratch.agentDir, fake);
		const socketPath = join(scratch.dir, "rpc.sock");
		const paths = createHostDaemonPaths(scratch.agentDir);

		// `expect` allocates a real pty so the compiled binary resolves the
		// interactive app mode exactly as a terminal launch does (stdin and
		// stdout are both TTYs inside the spawned session).
		tui = spawn("expect", ["-c", "set timeout -1; spawn -noecho $env(COMPILED_HOST_QA_BINARY); expect eof"], {
			cwd: scratch.cwd,
			env: {
				...scrubBrandEnv(scratch.env),
				COMPILED_HOST_QA_BINARY: binaryPath,
				SENPI_RPC_SOCKET: socketPath,
				TERM: "xterm-256color",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		trackChild(tui);
		tui.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));
		tui.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));
		transcript.push(`spawn compiled-tui pid=${tui.pid} binary=${binaryPath}`);

		const info = await waitForSharedHost(socketPath, () => output);
		if (typeof info.serverVersion !== "string" || info.serverVersion.length === 0) {
			throw new Error(`shared host served no version: ${JSON.stringify(info)}`);
		}
		for (const capability of ["multi_session", "extension_events"]) {
			if (!info.capabilities.includes(capability)) {
				throw new Error(`shared host is missing capability ${capability}: ${JSON.stringify(info)}`);
			}
		}
		transcript.push(`assert get_protocol_info serverVersion=${info.serverVersion} capabilities=${info.capabilities.join(",")}`);
		if (plainText(output).includes(FALLBACK_NEEDLE)) {
			throw new Error(`compiled TUI fell back to a local session:\n${supervisorStderr(paths)}`);
		}
		transcript.push("assert fallback-warning=absent");

		stopTui(tui);
		tui = undefined;
		await stopSupervisor(paths, socketPath);
		supervisorStopped = true;
		transcript.push("assert supervisor-sigterm=clean pidfile-socket-removed");
		transcript.push("PASS compiled-host");
	} catch (error) {
		if (scratch) {
			const paths = createHostDaemonPaths(scratch.agentDir);
			transcript.push(`observed fallback-warning=${plainText(output).includes(FALLBACK_NEEDLE) ? "present" : "absent"}`);
			transcript.push(`supervisor-stderr: ${supervisorStderr(paths)}`);
		}
		transcript.push(`pty-tail: ${plainText(output).slice(-800) || "<empty>"}`);
		transcript.push(`FAIL compiled-host: ${error instanceof Error ? error.stack : String(error)}`);
		process.exitCode = 1;
	} finally {
		if (tui) stopTui(tui);
		// The supervisor is detached and outlives this process, so every exit path -
		// including a failed run - must reap it or the QA leaks a live host and a
		// bound socket into the developer's machine.
		if (!supervisorStopped && scratch) {
			const reaped = await reapSupervisor(createHostDaemonPaths(scratch.agentDir));
			transcript.push(`cleanup-supervisor=${reaped}`);
		}
		await fake?.stop().catch(() => undefined);
		await cleanupAllAndWait();
		transcript.push("cleanup=tui,supervisor,sockets,scratch-removed");
		if (outPath) writeFileSync(outPath, `${transcript.join("\n")}\n`);
		process.stdout.write(`${transcript.join("\n")}\n`);
		process.exit(process.exitCode ?? 0);
	}
}

/** Polls the public socket until the shared host answers; fails fast when the TUI prints the fallback warning. */
async function waitForSharedHost(socketPath, readOutput) {
	const deadline = Date.now() + READY_BUDGET_MS;
	while (Date.now() <= deadline) {
		if (plainText(readOutput()).includes(FALLBACK_NEEDLE)) {
			throw new Error("compiled TUI printed the shared-host fallback warning before the host became ready");
		}
		const info = await probeProtocolInfo(socketPath);
		if (info) return info;
		await delay(200);
	}
	throw new Error(`shared host socket never answered get_protocol_info within ${READY_BUDGET_MS}ms`);
}

function probeProtocolInfo(socketPath) {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(value);
		};
		const timer = setTimeout(() => finish(undefined), 500);
		socket.once("connect", () => socket.write('{"id":"compiled-host-qa","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			try {
				const parsed = JSON.parse(buffer.slice(0, newline));
				finish(parsed?.success === true ? parsed.data : undefined);
			} catch {
				finish(undefined);
			}
		});
		socket.once("error", () => finish(undefined));
		socket.once("close", () => finish(undefined));
	});
}

/**
 * The compiled binary under test must resolve its own brand, package root, and
 * runtime; identity inherited from a branded operator shell (omo and friends)
 * would silently redirect resource and version lookups away from the binary.
 */
function scrubBrandEnv(env) {
	const scrubbed = { ...env };
	for (const key of Object.keys(scrubbed)) {
		if (key.startsWith("OMO_")) delete scrubbed[key];
	}
	delete scrubbed.SENPI_PACKAGE_DIR;
	delete scrubbed.SENPI_RUNTIME;
	return scrubbed;
}

function plainText(raw) {
	return raw
		.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
		.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "")
		.replace(/\r/g, "");
}

function supervisorStderr(paths) {
	try {
		return readFileSync(paths.stderrLog, "utf8").trim() || "<empty>";
	} catch {
		return "<missing>";
	}
}

function stopTui(child) {
	try {
		child.kill("SIGTERM");
	} catch {}
}

async function stopSupervisor(paths, socketPath) {
	let pid;
	try {
		pid = JSON.parse(readFileSync(paths.pidFile, "utf8")).pid;
	} catch {
		throw new Error("supervisor pidfile missing after successful attach");
	}
	try {
		process.kill(pid, "SIGTERM");
	} catch {}
	const deadline = Date.now() + 10_000;
	while (Date.now() <= deadline) {
		if (!alive(pid) && !existsSync(socketPath) && !existsSync(paths.pidFile)) return;
		await delay(100);
	}
	throw new Error(`supervisor ${pid} did not clean up within 10s (socket=${existsSync(socketPath)} pidfile=${existsSync(paths.pidFile)})`);
}

/**
 * Best-effort teardown for a supervisor left behind by a failed run. Escalates
 * to SIGKILL so a wedged supervisor cannot survive the QA process.
 */
async function reapSupervisor(paths) {
	let pid;
	try {
		pid = JSON.parse(readFileSync(paths.pidFile, "utf8")).pid;
	} catch {
		return "none";
	}
	for (const signal of ["SIGTERM", "SIGKILL"]) {
		try {
			process.kill(pid, signal);
		} catch {
			return `already-gone(${pid})`;
		}
		const deadline = Date.now() + 5_000;
		while (Date.now() <= deadline) {
			if (!alive(pid)) return `${signal}(${pid})`;
			await delay(100);
		}
	}
	return `survived(${pid})`;
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

await main();
