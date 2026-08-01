import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export interface IdpLog {
	requests: { method: string; path: string; grantType?: string; resource?: string; note?: string }[];
	tokenHits: number;
	registerHits: number;
	discoveryHits: number;
	familyInvalidated: boolean;
}

export interface IdpFixture {
	baseUrl: string;
	mcpUrl: string;
	pid: number;
	getLog: () => Promise<IdpLog>;
	cleanup: () => Promise<void>;
}

export async function spawnOAuthIdp(args: string[] = []): Promise<IdpFixture> {
	const child = spawn(process.execPath, [join(fixtureDir, "oauth-idp.ts"), ...args], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	try {
		const ready = await waitForReady(
			child,
			() => stdout,
			() => stderr,
		);
		return {
			baseUrl: ready.url,
			mcpUrl: ready.mcpUrl,
			pid: child.pid ?? ready.pid,
			getLog: async () => (await fetch(`${ready.url}/__log`)).json() as Promise<IdpLog>,
			cleanup: async () => {
				await terminateChild(child);
			},
		};
	} catch (error) {
		await terminateChild(child);
		throw error;
	}
}

interface ReadyLine {
	url: string;
	mcpUrl: string;
	pid: number;
}

function waitForReady(child: ChildProcess, getStdout: () => string, getStderr: () => string): Promise<ReadyLine> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`idp did not report readiness. stderr=${getStderr()}`)), 4000);
		const onData = (): void => {
			const line = getStdout()
				.split(/\r?\n/)
				.find((entry) => entry.trim().length > 0);
			if (line === undefined) return;
			clearTimeout(timeout);
			child.stdout?.off("data", onData);
			resolve(JSON.parse(line) as ReadyLine);
		};
		child.stdout?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			child.stdout?.off("data", onData);
			reject(new Error(`idp exited before readiness code=${code} stderr=${getStderr()}`));
		});
	});
}

async function terminateChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([waitForExit(child), delay(1000)]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await waitForExit(child);
	}
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("exit", () => resolve()));
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
