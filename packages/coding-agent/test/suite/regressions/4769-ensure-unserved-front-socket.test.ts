/**
 * senpi#4769 (omo#15003): a registered primary host whose process is alive but whose public socket can no longer
 * serve is judged by the socket, not by its pid.
 *
 * The field shape: a supervisor alive for days kept its public listener, but every connection was closed without
 * an answer (a pre-#7388 build resets; a current one answers `host_unavailable`) because it could not reach its host
 * child. The `ensure` that would have healed it refused `foreign_writer` for a writer pid that no longer existed, so
 * the device had no primary engine until someone stopped that process by hand.
 *
 * - A socket that ACCEPTS and then cannot serve, registered by a writer that is gone (or by this process), is
 *   stopped and replaced; the replaced generation's stderr log is kept, because it is the only record of why.
 * - The same socket registered by a LIVE foreign writer is still refused (I1: its owner can act on it).
 * - A socket that accepts and holds the connection silent past the probe deadline is a busy host, never replaced.
 *   The deadline is driven by a virtual clock; the unserved cases never advance it, so their verdict can only come
 *   from the socket closing.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { readHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { HostEnsureRefusedError } from "../../../src/modes/rpc/host-decision.ts";
import { createHostDaemonPaths, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { processIsLive, waitForStartTime } from "../../../src/utils/process-identity.ts";
import { hostSpawnEnv } from "../../helpers/rpc-host-spawn-env.ts";
import { reapSpawnedHosts } from "../../helpers/spawned-host-reaper.ts";

const fixture = join(import.meta.dirname, "..", "..", "fixtures", "rpc-host-fixture.mjs");
const CAPABILITIES = "multi_session,extension_events,session_context,session_kind";
const OLD_GENERATION_LOG = "senpi rpc host supervisor: connection to the host failed: connect ENOENT (old generation)";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
	const pending = roots.splice(0);
	await reapSpawnedHosts({ children: children.splice(0), roots: pending });
	for (const root of pending) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}, 30_000);

type Front = "reset" | "unavailable" | "held";
type Writer = "gone" | "self" | "live";
type Qa = { root: string; agentDir: string; socket: string };

describe.skipIf(process.platform === "win32")("ensure judges a registered primary by its socket (#4769)", () => {
	it.each([
		["gone", "reset"],
		["gone", "unavailable"],
		["self", "reset"],
		["self", "unavailable"],
	] as const)(
		"replaces a live process whose socket accepts but cannot serve (writer %s, front %s)",
		async (writer, front) => {
			const qa = await scratch(`${writer}-${front}`);
			const host = await startFront(qa, front);
			await register(qa, host, writer);
			const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
			await writeFile(paths.stderrLog, `${OLD_GENERATION_LOG}\n`, { mode: 0o600 });
			const exited = once(host.child, "exit");

			const result = await ensureHost({
				agentDir: qa.agentDir,
				socket: qa.socket,
				_test: { ...fixtureLaunch(qa), servingProbeExpiry: virtualClock().expire },
			});
			result.release();

			await exited;
			expect(result.reused).toBe(false);
			expect(result.pid).not.toBe(host.pid);
			expect(await readHostRegistration(paths)).toMatchObject({ record: { pid: result.pid } });
			expect(await answers(qa.socket)).toBe(true);
			expect(await readFile(join(paths.dir, "stderr.prev.log"), "utf8")).toContain(OLD_GENERATION_LOG);
		},
	);

	it("still refuses foreign_writer while the writer that registered the unserved host is alive", async () => {
		const qa = await scratch("live-writer");
		const host = await startFront(qa, "unavailable");
		await register(qa, host, "live");

		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { ...fixtureLaunch(qa), servingProbeExpiry: virtualClock().expire },
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(processIsLive(host.pid)).toBe(true);
	});

	it("never replaces a host that holds the connection silent past the probe deadline", async () => {
		const qa = await scratch("held");
		const host = await startFront(qa, "held");
		await register(qa, host, "gone");
		const clock = virtualClock();

		const outcome = ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: { ...fixtureLaunch(qa), servingProbeExpiry: clock.expire },
		}).then(
			() => "resolved",
			(error: unknown) => error,
		);
		const deadlineMs = await clock.requested();
		expect(deadlineMs).toBeGreaterThan(0);
		// Before the deadline the probe has no verdict: nothing was decided, nothing signalled.
		const early = await Promise.race([outcome, Promise.resolve("pending")]);
		expect(early).toBe("pending");
		clock.advance();

		const failure = await outcome;
		expect(failure).toBeInstanceOf(HostEnsureRefusedError);
		expect((failure as HostEnsureRefusedError).reason).toBe("foreign_writer");
		expect(processIsLive(host.pid)).toBe(true);
	});
});

async function scratch(label: string): Promise<Qa> {
	const root = await mkdtemp(join(tmpdir(), `senpi-4769-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

function fixtureLaunch(qa: Qa) {
	return {
		existingHostProbeTimeoutMs: 1,
		stopTimeoutMs: 5_000,
		spawn: { command: process.execPath, args: [fixture, qa.socket, VERSION, CAPABILITIES, "answer"] },
	};
}

/**
 * A stand-in supervisor: alive (it blocks reading a pipe the test holds), listening on the public socket, and either
 * closing every connection unanswered, answering only `host_unavailable`, or holding it silent.
 */
async function startFront(qa: Qa, front: Front): Promise<{ child: ChildProcess; pid: number }> {
	const script = [
		'const net = require("node:net");',
		"const mode = process.env.FRONT_MODE;",
		"net.createServer((client) => {",
		'  client.on("error", () => {});',
		'  if (mode === "reset") return client.destroy();',
		'  if (mode === "held") return;',
		'  client.once("data", (chunk) => {',
		'    const id = JSON.parse(String(chunk).split("\\n")[0]).id;',
		'    client.end(JSON.stringify({ id, type: "response", command: "get_protocol_info", success: false,',
		'      error: "host_unavailable: connect ENOENT", errorCode: "host_unavailable" }) + "\\n");',
		"  });",
		'}).listen(process.env.FRONT_SOCKET, () => process.stdout.write("listening\\n"));',
		"process.stdin.resume();",
	].join("\n");
	const child = spawn(process.execPath, ["-e", script], {
		stdio: ["pipe", "pipe", "inherit"],
		env: { ...hostSpawnEnv(), FRONT_SOCKET: qa.socket, FRONT_MODE: front },
	});
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		child.stdout?.once("data", () => resolve());
		child.once("exit", (code) => reject(new Error(`front exited before listening (code ${code})`)));
	});
	if (child.pid === undefined) throw new Error("front did not spawn");
	return { child, pid: child.pid };
}

/** The registration a previous `host ensure` left: the generation record names the host and the process that wrote it. */
async function register(qa: Qa, host: { pid: number }, writer: Writer): Promise<void> {
	const paths = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir });
	const stamp = await writerStamp(writer);
	const instanceId = `primary-${host.pid}`;
	const record = {
		pid: host.pid,
		processStartTime: (await waitForStartTime(host.pid, 10_000)) ?? null,
		instance_id: instanceId,
		generation: 1,
		socket: qa.socket,
		writer: stamp,
	};
	await mkdir(join(paths.generationsDir, instanceId), { recursive: true, mode: 0o700 });
	await writeFile(join(paths.generationsDir, instanceId, "host.pid"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
	const pointer = { layout: 2, instance_id: instanceId, generation_dir: `generations/${instanceId}`, writer: stamp };
	await writeFile(paths.pointerFile, `${JSON.stringify(pointer)}\n`, { mode: 0o600 });
}

async function writerStamp(writer: Writer): Promise<{ pid: number; startTime: string | null }> {
	if (writer === "self") return { pid: process.pid, startTime: (await waitForStartTime(process.pid, 10_000)) ?? null };
	// A writer process that blocks on a pipe until the test closes it: `live` keeps it open, `gone` closes it and
	// waits for the exit, so the recorded identity names a process that provably no longer exists.
	const child = spawn(
		process.execPath,
		["-e", "process.stdin.resume(); process.stdin.on('end', () => process.exit(0))"],
		{
			stdio: ["pipe", "ignore", "ignore"],
		},
	);
	children.push(child);
	await once(child, "spawn");
	const pid = child.pid ?? 0;
	const startTime = (await waitForStartTime(pid, 10_000)) ?? null;
	if (writer === "gone") {
		const exited = once(child, "exit");
		child.stdin?.end();
		await exited;
	}
	return { pid, startTime };
}

/** The probe deadline as a test-driven clock: `requested` settles when the probe arms it, `advance` expires it. */
function virtualClock() {
	const armed: Array<{ ms: number; expire: () => void }> = [];
	let notify: ((ms: number) => void) | undefined;
	return {
		expire: (ms: number, signal: AbortSignal): Promise<void> =>
			new Promise<void>((resolve) => {
				if (signal.aborted) return;
				armed.push({ ms, expire: resolve });
				notify?.(ms);
			}),
		requested: (): Promise<number> =>
			armed[0] !== undefined ? Promise.resolve(armed[0].ms) : new Promise<number>((resolve) => (notify = resolve)),
		advance: (): void => {
			for (const entry of armed.splice(0)) entry.expire();
		},
	};
}

/** Whether the socket answers `get_protocol_info` with success: the replacement host is serving. */
function answers(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		socket.once("connect", () => socket.write('{"id":"qa","type":"get_protocol_info"}\n'));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			const newline = buffer.indexOf("\n");
			if (newline === -1) return;
			socket.destroy();
			resolve(JSON.parse(buffer.slice(0, newline)).success === true);
		});
		socket.once("error", () => resolve(false));
	});
}
