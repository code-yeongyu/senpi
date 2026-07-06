import { type ChildProcessByStdio, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export interface StdioConnection {
	client: Client;
	transport: StdioClientTransport;
}

export interface HttpFixture {
	url: string;
	pid: number;
	stdout: string;
	stderr: string;
	cleanup: () => Promise<void>;
}

export interface HttpConnection {
	client: Client;
	transport: StreamableHTTPClientTransport;
}

export function stdioFixtureCommand(): { command: string; args: string[] } {
	return { command: process.execPath, args: [join(fixtureDir, "stdio-server.ts")] };
}

export async function connectToStdioFixture(args: string[]): Promise<StdioConnection> {
	const command = stdioFixtureCommand();
	const transport = new StdioClientTransport({
		command: command.command,
		args: [...command.args, ...args],
		stderr: "pipe",
	});
	const client = new Client({ name: "fixture-selftest", version: "1.0.0" });
	await client.connect(transport, { timeout: 2000 });
	return { client, transport };
}

export async function spawnHttpFixture(args: string[]): Promise<HttpFixture> {
	const child = spawn(process.execPath, [join(fixtureDir, "http-server.ts"), ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const line = await waitForFirstStdoutLine(
		child,
		() => stdout,
		() => stderr,
	);
	const parsed = parseHttpReadyLine(line);
	return {
		url: parsed.url,
		pid: child.pid ?? parsed.pid,
		stdout,
		stderr,
		cleanup: async () => {
			if (child.exitCode === null) child.kill("SIGTERM");
			await waitForExit(child);
			await assertProcessDead(child.pid ?? parsed.pid);
		},
	};
}

export async function connectToHttpFixture(url: string, bearerToken?: string): Promise<HttpConnection> {
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: bearerToken === undefined ? undefined : { headers: { authorization: `Bearer ${bearerToken}` } },
	});
	const client = new Client({ name: "fixture-selftest", version: "1.0.0" });
	await client.connect(transport, { timeout: 2000 });
	return { client, transport };
}

export async function assertProcessDead(pid: number): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`fixture process still alive: ${pid}`);
}

function waitForFirstStdoutLine(
	child: ChildProcessByStdio<null, Readable, Readable>,
	getStdout: () => string,
	getStderr: () => string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`HTTP fixture did not report readiness. stderr=${getStderr()}`));
		}, 3000);
		const onData = (): void => {
			const line = getStdout()
				.split(/\r?\n/)
				.find((entry) => entry.trim().length > 0);
			if (!line) return;
			clearTimeout(timeout);
			child.stdout.off("data", onData);
			resolve(line);
		};
		child.stdout.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`HTTP fixture exited before readiness code=${code} stderr=${getStderr()}`));
		});
	});
}

function parseHttpReadyLine(line: string): { url: string; pid: number } {
	const parsed: unknown = JSON.parse(line);
	if (!isReadyLine(parsed)) {
		throw new Error(`invalid HTTP fixture readiness line: ${line}`);
	}
	return parsed;
}

function isReadyLine(value: unknown): value is { url: string; pid: number } {
	return (
		typeof value === "object" &&
		value !== null &&
		"url" in value &&
		"pid" in value &&
		typeof value.url === "string" &&
		typeof value.pid === "number"
	);
}

function waitForExit(child: ChildProcessByStdio<null, Readable, Readable>): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
