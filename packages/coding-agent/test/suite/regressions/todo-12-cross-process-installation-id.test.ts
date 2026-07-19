import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { describe, it } from "vitest";

type WireRecord = { readonly [key: string]: unknown };

type SourceClient = {
	readonly child: ChildProcessWithoutNullStreams;
	readonly lines: Interface;
	readonly responses: AsyncIterableIterator<string>;
	readonly stderr: string[];
};

type SandboxPaths = {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly homeDir: string;
	readonly tempDir: string;
};

const PROCESS_COUNT = 10;
const codingAgentDir = process.cwd();
const repoRoot = resolve(codingAgentDir, "../..");

describe("todo-12 cross-process installation id", () => {
	it("returns the one persisted id when source app-server processes read an empty shared agent directory", async () => {
		// Given: ten initialized source app-server OS processes sharing one empty isolated agent directory.
		const root = await mkdtemp(join(tmpdir(), "s12-"));
		const paths: SandboxPaths = {
			root,
			agentDir: join(root, "a"),
			sessionDir: join(root, "s"),
			homeDir: join(root, "h"),
			tempDir: join(root, "t"),
		};
		const clients: SourceClient[] = [];
		try {
			await Promise.all(
				[paths.agentDir, paths.sessionDir, paths.homeDir, paths.tempDir].map((path) =>
					mkdir(path, { recursive: true }),
				),
			);
			const env = hermeticEnv(paths);
			for (let index = 0; index < PROCESS_COUNT; index += 1) {
				clients.push(startSourceAppServer(env));
			}
			await Promise.all(
				clients.map((client, index) =>
					sendRequest(client, {
						id: index + 1,
						method: "initialize",
						params: {
							clientInfo: { name: "cross-process-regression", title: "Cross Process", version: "0.0.1" },
							capabilities: { experimentalApi: true, requestAttestation: false },
						},
					}).then(assertResult),
				),
			);

			// When: every process performs its first remote-control status read concurrently.
			const statuses = await Promise.all(
				clients.map((client, index) =>
					sendRequest(client, { id: 100 + index, method: "remoteControl/status/read" }).then(readInstallationId),
				),
			);

			// Then: every returned UUID equals the one value persisted for the shared agent directory.
			const persistedInstallationId = (
				await readFile(join(paths.agentDir, "app-server", "installation-id"), "utf8")
			).trim();
			if (statuses.some((installationId) => installationId !== persistedInstallationId)) {
				throw new Error(
					`cross-process installation IDs diverged: persisted=${persistedInstallationId}; returned=${statuses.join(",")}`,
				);
			}
		} finally {
			await Promise.all(clients.map((client) => stopSourceAppServer(client)));
			await rm(root, { recursive: true, force: true });
		}
	}, 120_000);
});

function hermeticEnv(paths: SandboxPaths): NodeJS.ProcessEnv {
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

function startSourceAppServer(env: NodeJS.ProcessEnv): SourceClient {
	const child = spawn(
		process.execPath,
		[
			join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
			"--tsconfig",
			join(repoRoot, "tsconfig.json"),
			join(codingAgentDir, "src", "cli-main.ts"),
			"app-server",
			"--listen",
			"stdio://",
		],
		{ cwd: codingAgentDir, env, stdio: ["pipe", "pipe", "pipe"] },
	);
	const stderr: string[] = [];
	child.stderr.on("data", (chunk: Buffer) => {
		stderr.push(chunk.toString("utf8"));
	});
	const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
	return { child, lines, responses: lines[Symbol.asyncIterator](), stderr };
}

async function sendRequest(client: SourceClient, request: WireRecord): Promise<WireRecord> {
	const response = nextResponse(client);
	await new Promise<void>((resolveWrite, rejectWrite) => {
		client.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
			if (error) {
				rejectWrite(error);
				return;
			}
			resolveWrite();
		});
	});
	const parsed = await response;
	if (!isRecord(parsed)) throw new Error("source app-server response must be an object");
	return parsed;
}

async function nextResponse(client: SourceClient): Promise<unknown> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => reject(new Error("source app-server response timed out")), 30_000);
	});
	try {
		const next = await Promise.race([client.responses.next(), timeoutPromise]);
		if (next.done) {
			throw new Error(
				`source app-server stdout closed before a response (exit=${String(client.child.exitCode)}, signal=${String(client.child.signalCode)}): ${client.stderr.join("").trim()}`,
			);
		}
		return JSON.parse(next.value);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function assertResult(response: WireRecord): void {
	if (!("result" in response)) throw new Error("source app-server initialization failed");
}

function readInstallationId(response: WireRecord): string {
	assertResult(response);
	const result = response.result;
	if (!isRecord(result) || typeof result.installationId !== "string") {
		throw new Error("remote-control status response is missing installationId");
	}
	return result.installationId;
}

async function stopSourceAppServer(client: SourceClient): Promise<void> {
	client.child.stdin.end();
	client.lines.close();
	if (client.child.exitCode !== null || client.child.signalCode !== null) return;
	client.child.kill("SIGTERM");
	try {
		await waitForClose(client.child, 5_000);
	} catch (error: unknown) {
		client.child.kill("SIGKILL");
		await waitForClose(client.child, 5_000);
		if (!(error instanceof Error)) throw error;
	}
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveClose, rejectClose) => {
		const timeout = setTimeout(() => rejectClose(new Error("source app-server shutdown timed out")), timeoutMs);
		child.once("close", () => {
			clearTimeout(timeout);
			resolveClose();
		});
	});
}

function isRecord(value: unknown): value is WireRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
