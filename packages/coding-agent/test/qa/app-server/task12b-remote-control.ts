import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { type RawData } from "ws";

type WireRecord = { readonly [key: string]: unknown };

type RunningServer = {
	readonly child: ChildProcess;
	readonly port: number;
};

const QA_PORTS = [18990, 18991, 18992, 18993, 18994, 18995, 18996, 18997, 18998, 18999] as const;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const codingAgentDir = process.cwd();
const repoRoot = resolve(codingAgentDir, "../..");

async function main(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "senpi-qa-task12b-"));
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	const homeDir = join(root, "home");
	const tempDir = join(root, "tmp");
	const sockets: WebSocket[] = [];
	const servers: RunningServer[] = [];
	const ports: number[] = [];
	try {
		await Promise.all([
			mkdir(agentDir, { recursive: true }),
			mkdir(sessionDir, { recursive: true }),
			mkdir(homeDir, { recursive: true }),
			mkdir(tempDir, { recursive: true }),
		]);
		const qaPorts = await findQaPorts(QA_PORTS.length);
		ports.push(...qaPorts);
		const env = hermeticEnv({ root, agentDir, sessionDir, homeDir, tempDir });
		const crossProcessServers = await Promise.all(qaPorts.map((qaPort) => startSourceAppServer(qaPort, env)));
		servers.push(...crossProcessServers);
		const crossProcessSockets = await Promise.all(
			crossProcessServers.map(({ port: serverPort }) => connect(serverPort)),
		);
		sockets.push(...crossProcessSockets);
		await Promise.all(crossProcessSockets.map((socket, index) => initialize(socket, true, index + 1)));
		const crossProcessStatuses = await Promise.all(
			crossProcessSockets.map((socket, index) =>
				sendRequest(socket, 1000 + index, "remoteControl/status/read").then(assertStatusResult),
			),
		);
		const persistedAfterRace = (await readFile(join(agentDir, "app-server", "installation-id"), "utf8")).trim();
		assert.ok(crossProcessStatuses.every((status) => status.installationId === persistedAfterRace));

		await closeSockets(sockets);
		await Promise.all(crossProcessServers.map(({ child }) => stopServer(child)));

		const qaPort = qaPorts[0] ?? fail("missing QA port");
		let server = await startSourceAppServer(qaPort, env);
		servers.push(server);

		const stable = await connect(qaPort);
		sockets.push(stable);
		await initialize(stable, false, 1);
		assertRpcError(
			await sendRequest(stable, 2, "remoteControl/status/read"),
			-32600,
			"remoteControl/status/read requires experimentalApi capability",
		);
		assertRpcError(
			await sendRequest(stable, 3, "remoteControl/client/list", { environmentId: "local-only" }),
			-32600,
			"remoteControl/client/list requires experimentalApi capability",
		);

		const experimental = await Promise.all(
			Array.from({ length: 8 }, async (_, index) => {
				const socket = await connect(qaPort);
				sockets.push(socket);
				await initialize(socket, true, 10 + index);
				return socket;
			}),
		);
		const firstStatuses = await Promise.all(
			experimental.map((socket, index) =>
				sendRequest(socket, 100 + index, "remoteControl/status/read").then(assertStatusResult),
			),
		);
		const firstInstallationId = firstStatuses[0]?.installationId;
		assert.equal(typeof firstInstallationId, "string");
		assert.match(firstInstallationId, UUID_V4_PATTERN);
		assert.ok(firstStatuses.every((status) => status.installationId === firstInstallationId));

		const installationIdPath = join(agentDir, "app-server", "installation-id");
		assert.equal(await readFile(installationIdPath, "utf8"), `${firstInstallationId}\n`);
		assert.equal((await stat(installationIdPath)).mode & 0o777, 0o600);
		const repeatedStatus = assertStatusResult(
			await sendRequest(experimental[0] ?? fail("missing experimental client"), 200, "remoteControl/status/read"),
		);
		assert.equal(repeatedStatus.installationId, firstInstallationId);
		assertRpcError(
			await sendRequest(experimental[0] ?? fail("missing experimental client"), 201, "remoteControl/client/list", {
				environmentId: "local-only",
			}),
			-32603,
			"remote control is unavailable for this app-server",
		);

		await closeSockets(sockets);
		await stopServer(server.child);
		server = await startSourceAppServer(qaPort, env);
		servers.push(server);
		const reloaded = await connect(qaPort);
		sockets.push(reloaded);
		await initialize(reloaded, true, 300);
		const reloadedStatus = assertStatusResult(await sendRequest(reloaded, 301, "remoteControl/status/read"));
		assert.equal(reloadedStatus.installationId, firstInstallationId);
	} finally {
		await closeSockets(sockets);
		await Promise.all(servers.map(({ child }) => stopServer(child)));
		await rm(root, { recursive: true, force: true });
		await Promise.all(ports.map((qaPort) => assertPortReusable(qaPort)));
	}

	console.log("STATUS_ENUM=disabled");
	console.log("INSTALLATION_ID_STABLE=1");
	console.log("CLIENT_LIST_ERROR=1");
	console.log("EXIT=0");
}

function hermeticEnv(paths: {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly homeDir: string;
	readonly tempDir: string;
}): NodeJS.ProcessEnv {
	return {
		CI: "1",
		HOME: paths.homeDir,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		NO_PROXY: "127.0.0.1,localhost",
		PATH: process.env.PATH,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		SENPI_CODING_AGENT_DIR: paths.agentDir,
		SENPI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
		TMPDIR: paths.tempDir,
		USERPROFILE: paths.homeDir,
		XDG_CACHE_HOME: join(paths.root, "xdg-cache"),
		XDG_CONFIG_HOME: join(paths.root, "xdg-config"),
		XDG_DATA_HOME: join(paths.root, "xdg-data"),
	};
}

async function startSourceAppServer(port: number, env: NodeJS.ProcessEnv): Promise<RunningServer> {
	const child = spawn(
		process.execPath,
		[
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(codingAgentDir, "src", "cli-main.ts"),
			"app-server",
			"--listen",
			`ws://127.0.0.1:${port}`,
			"--ws-auth",
			"off",
		],
		{ cwd: codingAgentDir, env, stdio: ["ignore", "pipe", "pipe"] },
	);
	child.stdout?.resume();
	child.stderr?.resume();
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	try {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (spawnError) throw spawnError;
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`source app-server exited before readiness: ${String(child.exitCode ?? child.signalCode)}`);
			}
			if ((await readyStatus(port)) === 200) return { child, port };
			await delay(25);
		}
		throw new Error("source app-server did not become ready within 30 seconds");
	} catch (error: unknown) {
		await stopServer(child);
		throw error;
	}
}

async function stopServer(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	try {
		await waitForClose(child, 5_000);
	} catch (error: unknown) {
		child.kill("SIGKILL");
		await waitForClose(child, 5_000);
		if (!(error instanceof Error)) throw error;
	}
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveClose, rejectClose) => {
		const timeout = setTimeout(() => rejectClose(new Error("source app-server shutdown timed out")), timeoutMs);
		child.once("close", () => {
			clearTimeout(timeout);
			resolveClose();
		});
	});
}

async function connect(port: number): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
	await new Promise<void>((resolveOpen, rejectOpen) => {
		const timeout = setTimeout(() => rejectOpen(new Error("websocket connection timed out")), 10_000);
		socket.once("open", () => {
			clearTimeout(timeout);
			resolveOpen();
		});
		socket.once("error", (error) => {
			clearTimeout(timeout);
			rejectOpen(error);
		});
	});
	return socket;
}

async function initialize(socket: WebSocket, experimentalApi: boolean, id: number): Promise<void> {
	const response = await sendRequest(socket, id, "initialize", {
		clientInfo: { name: "task12b-qa", title: "Task 12b QA", version: "0.0.1" },
		capabilities: { experimentalApi, requestAttestation: false },
	});
	assert.ok("result" in response);
}

function sendRequest(socket: WebSocket, id: number, method: string, params?: unknown): Promise<WireRecord> {
	return new Promise((resolveResponse, rejectResponse) => {
		const timeout = setTimeout(() => {
			cleanup();
			rejectResponse(new Error(`${method} timed out`));
		}, 10_000);
		const onMessage = (data: RawData, isBinary: boolean): void => {
			if (isBinary) return;
			try {
				const parsed: unknown = JSON.parse(data.toString("utf8"));
				if (!isRecord(parsed) || parsed.id !== id) return;
				cleanup();
				resolveResponse(parsed);
			} catch (error: unknown) {
				cleanup();
				rejectResponse(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onError = (error: Error): void => {
			cleanup();
			rejectResponse(error);
		};
		const cleanup = (): void => {
			clearTimeout(timeout);
			socket.off("message", onMessage);
			socket.off("error", onError);
		};
		socket.on("message", onMessage);
		socket.on("error", onError);
		const payload = params === undefined ? { id, method } : { id, method, params };
		socket.send(JSON.stringify(payload), (error) => {
			if (!error) return;
			cleanup();
			rejectResponse(error);
		});
	});
}

function assertStatusResult(response: WireRecord): { readonly installationId: string } {
	assert.ok("result" in response);
	const result = response.result;
	assert.ok(isRecord(result));
	assert.deepEqual(Object.keys(result).sort(), ["environmentId", "installationId", "serverName", "status"]);
	assert.equal(result.status, "disabled");
	assert.equal(result.serverName, "senpi app-server");
	assert.equal(result.environmentId, null);
	const installationId = result.installationId;
	if (typeof installationId !== "string") {
		throw new Error("remote-control status installationId must be a string");
	}
	assert.match(installationId, UUID_V4_PATTERN);
	return { installationId };
}

function assertRpcError(response: WireRecord, code: number, message: string): void {
	assert.ok("error" in response);
	const error = response.error;
	assert.ok(isRecord(error));
	assert.deepEqual(error, { code, message });
}

async function closeSockets(sockets: WebSocket[]): Promise<void> {
	await Promise.all(sockets.splice(0).map((socket) => closeSocket(socket)));
}

function closeSocket(socket: WebSocket): Promise<void> {
	if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise((resolveClose) => {
		const timeout = setTimeout(() => {
			socket.terminate();
			resolveClose();
		}, 2_000);
		socket.once("close", () => {
			clearTimeout(timeout);
			resolveClose();
		});
		socket.close();
	});
}

function readyStatus(port: number): Promise<number> {
	return new Promise((resolveStatus) => {
		const req = request({ host: "127.0.0.1", port, path: "/readyz", method: "GET", timeout: 500 }, (response) => {
			response.resume();
			resolveStatus(response.statusCode ?? 0);
		});
		req.once("timeout", () => req.destroy());
		req.once("error", () => resolveStatus(0));
		req.end();
	});
}

async function findQaPorts(count: number): Promise<number[]> {
	const ports: number[] = [];
	for (const port of QA_PORTS) {
		if (await canBind(port)) ports.push(port);
		if (ports.length === count) return ports;
	}
	throw new Error(`expected ${count} free ports in the QA range 18990-18999`);
}

async function assertPortReusable(port: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (await canBind(port)) return;
		await delay(25);
	}
	throw new Error(`QA port ${port} remained in use after bounded cleanup retries`);
}

function canBind(port: number): Promise<boolean> {
	return new Promise((resolveBind, rejectBind) => {
		const probe = createServer();
		probe.unref();
		probe.once("error", (error: unknown) => {
			if (isNodeErrorCode(error, "EADDRINUSE")) {
				resolveBind(false);
				return;
			}
			rejectBind(error);
		});
		probe.listen(port, "127.0.0.1", () => {
			probe.close(() => resolveBind(true));
		});
	});
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new Error(message);
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
