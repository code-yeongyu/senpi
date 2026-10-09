import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { REPOSITORY_IDENTITY_ENTRY_TYPE, type RepositoryIdentity } from "../../../src/core/repository-identity.ts";

// Shared fixtures for the issue #2184 regressions (moved-repository sessions reached from /resume,
// --continue, and the session lists, plus the cross-process session hold).

export const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
export const ROOT_COMMIT = "c".repeat(40);
export const RECORDED: RepositoryIdentity = { rootCommits: [ROOT_COMMIT] };

const rootTsconfigPath = resolve(__dirname, "../../../../..", "tsconfig.json");
const CHILD_TIMEOUT_MS = 15_000;
const tempDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();
let restoreAgentDir: (() => void) | undefined;

export function isolateAgentDir(): string {
	const inherited = process.env[ENV_AGENT_DIR];
	restoreAgentDir = () => {
		if (inherited === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = inherited;
	};
	const agentDir = join(tempDir("senpi-2184-agent-"), "agent");
	process.env[ENV_AGENT_DIR] = agentDir;
	return agentDir;
}

export function cleanupIssue2184(): void {
	for (const child of liveChildren) child.kill("SIGKILL");
	liveChildren.clear();
	restoreAgentDir?.();
	restoreAgentDir = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = "senpi-2184-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

export function srcUrl(relative: string): string {
	return pathToFileURL(resolve(__dirname, "../../../src", relative)).href;
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

export function makeRepo(dir: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	writeFileSync(join(dir, "README.md"), content);
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
}

export interface SessionFixture {
	readonly id?: string;
	readonly identity?: RepositoryIdentity;
	readonly text?: string;
	readonly timestamp?: string;
}

export function writeSession(sessionDir: string, cwd: string, fixture: SessionFixture = {}): string {
	const id = fixture.id ?? SESSION_ID;
	const timestamp = fixture.timestamp ?? "2026-09-27T00:00:00.000Z";
	mkdirSync(sessionDir, { recursive: true });
	const file = join(sessionDir, `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`);
	const entries: unknown[] = [
		{ type: "session", version: 3, id, timestamp, cwd },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: fixture.text ?? "remember 42", timestamp: Date.parse(timestamp) },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "42 noted" }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.parse(timestamp) + 1,
			},
		},
	];
	if (fixture.identity) {
		entries.push({
			type: "custom",
			id: "r1",
			parentId: "a1",
			timestamp,
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: fixture.identity,
		});
	}
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

export interface ModuleChild {
	readonly child: ChildProcess;
	readonly line: (prefix: string) => Promise<string>;
	readonly send: (text: string) => void;
	readonly exit: () => Promise<number | null>;
	readonly output: () => string;
}

export function spawnModuleChild(body: string, env: Record<string, string> = {}, cwd?: string): ModuleChild {
	const child = spawn(process.execPath, ["--input-type=module", "-e", body], {
		cwd,
		env: { ...process.env, PI_OFFLINE: "1", TSX_TSCONFIG_PATH: rootTsconfigPath, ...env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	liveChildren.add(child);
	let output = "";
	const waiters: Array<{ prefix: string; resolve: (line: string) => void }> = [];
	const exited = new Promise<number | null>((resolveExit, reject) => {
		child.on("error", reject);
		child.on("close", (code) => {
			liveChildren.delete(child);
			resolveExit(code);
		});
	});
	const deliver = (): void => {
		for (const line of output.split("\n")) {
			for (const waiter of waiters.slice()) {
				if (line.startsWith(waiter.prefix)) {
					waiters.splice(waiters.indexOf(waiter), 1);
					waiter.resolve(line);
				}
			}
		}
	};
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		deliver();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const timeout = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	void exited.finally(() => clearTimeout(timeout));
	return {
		child,
		line: (prefix) =>
			new Promise<string>((resolveLine, reject) => {
				waiters.push({ prefix, resolve: resolveLine });
				deliver();
				void exited.then((code) => reject(new Error(`child exited (${code}) before "${prefix}":\n${output}`)));
			}),
		send: (text) => child.stdin?.write(text),
		exit: () => {
			child.stdin?.end();
			return exited;
		},
		output: () => output,
	};
}
