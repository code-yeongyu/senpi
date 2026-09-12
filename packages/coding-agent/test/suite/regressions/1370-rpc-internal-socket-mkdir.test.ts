import * as childProcess from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInternalSocketPath, runHostSupervisor } from "../../../src/modes/rpc/host-lifecycle.ts";
import {
	createSocketSecret,
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../../../src/modes/rpc/socket-transport.ts";
import { hermeticProviderEnv } from "../../helpers/rpc-hermetic.ts";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof childProcess>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

// Regression coverage for https://github.com/code-yeongyu/senpi/issues/1370
describe("createInternalSocketPath", () => {
	const created: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])("provisions the win32 public secret before spawning (existing=%s)", async (existing) => {
		const agentDir = mkdtempSync(join(tmpdir(), "rpc1370-"));
		created.push(agentDir);
		const socket = join(agentDir, "rpc", "rpc.sock");
		const secretPath = socketSecretPath(socket);
		const original = existing ? await createSocketSecret(secretPath) : undefined;
		const reachedSpawn = new Error("bootstrap reached child spawn");
		vi.stubGlobal("process", Object.create(process, { platform: { value: "win32" } }));

		await vi.mocked(childProcess.spawn).withImplementation(
			() => {
				throw reachedSpawn;
			},
			async () => {
				await expect(runHostSupervisor({ socket, agentDir, hostArgs: [] })).rejects.toBe(reachedSpawn);
			},
		);
		const secret = await readSocketSecret(secretPath);
		expect(secret).toHaveLength(32);
		if (original) expect(secret).toEqual(original);
	});

	it("starts the real direct supervisor route on a fresh profile and serves the public endpoint", async () => {
		// Keep the private hop below macOS sun_path's limit and out of other tests' OS-temp scans.
		const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "rpc1370-"));
		created.push(root);
		const agentDir = join(root, "agent");
		const socketPath = join(root, "rpc.sock");
		const secretPath = socketSecretPath(socketPath);
		expect(existsSync(join(agentDir, "rpc-host-daemon"))).toBe(false);
		expect(existsSync(secretPath)).toBe(false);
		const supervisor = childProcess.spawn(
			process.execPath,
			[
				"--import",
				import.meta.resolve("tsx"),
				resolve(import.meta.dirname, "../../../src/cli.ts"),
				"--internal-rpc-host-supervisor",
				"--socket",
				socketPath,
				"--agent-dir",
				agentDir,
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
			],
			{
				cwd: root,
				env: {
					...process.env,
					...hermeticProviderEnv(),
					PI_OFFLINE: "1",
					TMPDIR: root,
					TMP: root,
					TEMP: root,
					SENPI_CODING_AGENT_DIR: agentDir,
					SENPI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
					SENPI_RPC_HOST_COLD_START: "persistent",
				},
				stdio: ["ignore", "ignore", "pipe"],
			},
		);
		const exited = once(supervisor, "exit");
		const stderr = createInterface({ input: supervisor.stderr });
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), 30_000);
		const ready = (async () => {
			let output = "";
			for await (const line of stderr) {
				output = `${output}${line}\n`.slice(-16_000);
				if (line.includes("senpi rpc host ready on ")) return;
			}
			throw new Error(`supervisor exited before readiness:\n${output}`);
		})();
		try {
			await Promise.race([
				ready,
				once(abort.signal, "abort").then(() => {
					throw new Error("supervisor readiness timed out");
				}),
			]);
			const secret = process.platform === "win32" ? await readSocketSecret(secretPath) : undefined;
			const socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
			const lines = createInterface({ input: socket });
			try {
				await once(socket, "connect", { signal: abort.signal });
				const response = once(lines, "line", { signal: abort.signal });
				if (secret) sendSocketHandshake(socket, secret);
				socket.write(`${JSON.stringify({ id: "bootstrap", type: "get_protocol_info" })}\n`);
				const [line] = await response;
				expect(JSON.parse(line)).toMatchObject({ id: "bootstrap", success: true });
				if (secret) expect(await readFile(secretPath)).toEqual(secret);
			} finally {
				lines.close();
				socket.destroy();
			}
		} finally {
			clearTimeout(timer);
			supervisor.kill();
			const killTimer = setTimeout(() => supervisor.kill("SIGKILL"), 10_000);
			try {
				await exited;
			} finally {
				clearTimeout(killTimer);
				stderr.close();
			}
		}
	}, 45_000);

	it("creates the win32 internal directory when rpc-host-daemon does not exist yet", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "senpi-hlc-win32-"));
		created.push(agentDir);
		const daemonDir = join(agentDir, "rpc-host-daemon");
		expect(existsSync(daemonDir)).toBe(false);

		const internal = await createInternalSocketPath(daemonDir, "win32");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(daemonDir);
		expect(internal.socket.startsWith("\\\\.\\pipe\\")).toBe(true);
		expect(internal.secretPath).toBe(join(dir, "secret"));
	});

	it("keeps the posix internal directory in the OS temp dir", async () => {
		const internal = await createInternalSocketPath(join(tmpdir(), "senpi-hlc-unused"), "linux");

		const dir = internal.dir;
		if (dir === undefined) throw new Error("expected an internal socket directory");
		created.push(dir);
		expect(existsSync(dir)).toBe(true);
		expect(dirname(dir)).toBe(tmpdir());
		expect(internal.socket).toBe(join(dir, "host.sock"));
	});
});
