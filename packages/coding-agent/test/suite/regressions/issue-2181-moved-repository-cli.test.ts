import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FORK_PROMPT, REBIND_PROMPT } from "../../../src/cli/cross-project-session.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import {
	REPOSITORY_IDENTITY_ENTRY_TYPE,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../../../src/core/repository-identity.ts";
import { getDefaultSessionDir } from "../../../src/core/session-manager.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";

assertWorkspaceBuildPrerequisite(import.meta.url);

const cliPath = resolve(__dirname, "../../../src/cli.ts");
const mainPath = resolve(__dirname, "../../../src/main.ts");
const rootTsconfigPath = resolve(__dirname, "../../../../..", "tsconfig.json");
const SESSION_ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3";
const CHILD_TIMEOUT_MS = 15_000;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const tempDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();

afterEach(() => {
	for (const child of liveChildren) child.kill("SIGKILL");
	liveChildren.clear();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Moved {
	readonly agentDir: string;
	readonly oldCwd: string;
	readonly newCwd: string;
	readonly sessionFile: string;
}

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	});
}

function makeRepo(dir: string, content: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	writeFileSync(join(dir, "README.md"), content);
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "init");
}

async function movedRepository(recordedFrom?: string): Promise<Moved> {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "senpi-moved-repo-")));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const oldCwd = join(root, "old", "repo");
	const newCwd = join(root, "new", "repo");
	makeRepo(oldCwd, "moved\n");
	if (recordedFrom) makeRepo(join(root, recordedFrom), "unrelated\n");
	const identity = await readRepositoryIdentity(recordedFrom ? join(root, recordedFrom) : oldCwd);
	const sessionFile = writeSession(getDefaultSessionDir(oldCwd, agentDir), oldCwd, identity);
	mkdirSync(dirname(newCwd), { recursive: true });
	renameSync(oldCwd, newCwd);
	return { agentDir, oldCwd, newCwd, sessionFile };
}

function writeSession(sessionDir: string, cwd: string, identity: RepositoryIdentity | undefined): string {
	const file = join(sessionDir, `2026-09-27T00-00-00-000Z_${SESSION_ID}.jsonl`);
	const entries = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-09-27T00:00:00.000Z", cwd },
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-09-27T00:00:01.000Z",
			message: { role: "user", content: "remember 42", timestamp: 1 },
		},
		{
			type: "custom",
			id: "r1",
			parentId: "u1",
			timestamp: "2026-09-27T00:00:02.000Z",
			customType: REPOSITORY_IDENTITY_ENTRY_TYPE,
			data: identity,
		},
	];
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return file;
}

function interactiveArgs(parsed: Record<string, string>, cwd: string): string[] {
	const bootstrap = [
		"process.stdin.isTTY = true;",
		"process.stdout.isTTY = true;",
		`const { createSessionManager } = await import(${JSON.stringify(pathToFileURL(mainPath).href)});`,
		`const sm = await createSessionManager(${JSON.stringify(parsed)}, ${JSON.stringify(cwd)}, undefined, undefined, "interactive");`,
		`const result = { file: sm.getSessionFile(), cwd: sm.getCwd(), entries: sm.getEntries().map((e) => e.id) };`,
		'process.stdout.write("RESULT " + JSON.stringify(result) + "\\n", () => process.exit(0));',
	].join("\n");
	return ["--input-type=module", "-e", bootstrap];
}

async function runCli(args: string[], moved: Moved, stdin?: string): Promise<{ code: number | null; output: string }> {
	const child = spawn(process.execPath, args, {
		cwd: moved.newCwd,
		env: { ...process.env, [ENV_AGENT_DIR]: moved.agentDir, PI_OFFLINE: "1", TSX_TSCONFIG_PATH: rootTsconfigPath },
		stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	liveChildren.add(child);
	if (stdin !== undefined) child.stdin?.end(stdin);
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	// Pins a no-hang contract: without the bounded kill the test would block on the failure it guards.
	const timeout = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	try {
		const code = await new Promise<number | null>((resolveExit, reject) => {
			child.on("error", reject);
			child.on("close", resolveExit);
		});
		return { code, output: output.replace(ANSI, "") };
	} finally {
		clearTimeout(timeout);
		liveChildren.delete(child);
	}
}

function landed(output: string): { file: string; cwd: string; entries: string[] } {
	const line = output.split("\n").find((candidate) => candidate.startsWith("RESULT "));
	if (!line) throw new Error(`no RESULT line in:\n${output}`);
	return JSON.parse(line.slice("RESULT ".length));
}

describe("issue #2181 --session after the repository moved", () => {
	it("rebinds the session into the moved repository on y and keeps its history", async () => {
		const moved = await movedRepository();

		const result = await runCli(interactiveArgs({ session: SESSION_ID }, moved.newCwd), moved, "y\n");

		expect(result.output).toContain(REBIND_PROMPT);
		expect(result.output).toContain(moved.oldCwd);
		expect(result.output).toContain(moved.newCwd);
		const session = landed(result.output);
		expect(session.cwd).toBe(moved.newCwd);
		expect(dirname(session.file)).toBe(getDefaultSessionDir(moved.newCwd, moved.agentDir));
		expect(session.entries).toEqual(["u1", "r1"]);
		expect(existsSync(moved.sessionFile)).toBe(false);
	});

	it("rebinds without asking when --rebind names the session", async () => {
		const moved = await movedRepository();

		const result = await runCli(interactiveArgs({ rebind: SESSION_ID }, moved.newCwd), moved);

		expect(result.output).not.toContain(REBIND_PROMPT);
		expect(landed(result.output).cwd).toBe(moved.newCwd);
	});

	it("keeps the fork prompt for a session of a different repository", async () => {
		const moved = await movedRepository("elsewhere");

		const result = await runCli(interactiveArgs({ session: SESSION_ID }, moved.newCwd), moved, "n\n");

		expect(result.output).toContain(FORK_PROMPT);
		expect(result.output).not.toContain(REBIND_PROMPT);
		expect(result.output).toContain("Aborted.");
		expect(result.code).toBe(0);
		expect(existsSync(moved.sessionFile)).toBe(true);
	});

	it("prints the rebind and fork commands and exits non-zero without a terminal", async () => {
		const moved = await movedRepository();

		const result = await runCli([cliPath, "--session", SESSION_ID, "-p", "hi"], moved);

		expect(result.code).toBe(1);
		expect(result.output).toContain(`--rebind '${SESSION_ID}'`);
		expect(result.output).toContain(`--fork '${SESSION_ID}'`);
		expect(result.output).not.toContain(REBIND_PROMPT);
		expect(existsSync(moved.sessionFile)).toBe(true);
	});
});
