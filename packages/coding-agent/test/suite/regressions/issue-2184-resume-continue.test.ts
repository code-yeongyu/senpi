import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REBIND_PROMPT } from "../../../src/cli/cross-project-session.ts";
import { readRepositoryIdentity } from "../../../src/core/repository-identity.ts";
import { resolveResumeTarget } from "../../../src/core/resume-target.ts";
import { holdSessionFile, SessionHeldError } from "../../../src/core/session-holders.ts";
import { getDefaultSessionDir } from "../../../src/core/session-manager.ts";
import { assertWorkspaceBuildPrerequisite } from "../../support/workspace-build-prerequisite.ts";
import {
	cleanupIssue2184,
	isolateAgentDir,
	makeRepo,
	RECORDED,
	SESSION_ID,
	spawnModuleChild,
	tempDir,
	writeSession,
} from "./issue-2184-support.ts";

// Issue #2184: the in-session /resume choice and --continue offer the #2182 rebind for a session of
// the same repository recorded at another path; everything else resumes exactly as before.

assertWorkspaceBuildPrerequisite(import.meta.url);

const mainUrl = pathToFileURL(resolve(__dirname, "../../../src/main.ts")).href;

beforeEach(isolateAgentDir);
afterEach(cleanupIssue2184);

function sameRepoElsewhere() {
	const root = tempDir();
	const oldCwd = join(root, "old", "repo");
	const cwd = join(root, "new", "repo");
	mkdirSync(cwd, { recursive: true });
	const sessionFile = writeSession(getDefaultSessionDir(oldCwd), oldCwd, { identity: RECORDED });
	return { oldCwd, cwd, sessionFile, readIdentity: async () => RECORDED };
}

describe("issue #2184 /resume choice", () => {
	it("rebinds a same-repository session recorded elsewhere when the user confirms", async () => {
		const { oldCwd, cwd, sessionFile, readIdentity } = sameRepoElsewhere();
		const asked: string[] = [];

		const target = await resolveResumeTarget({
			sessionPath: sessionFile,
			cwd,
			readIdentity,
			confirm: async (sessionCwd) => {
				asked.push(sessionCwd);
				return true;
			},
		});

		expect(asked).toEqual([oldCwd]);
		expect(target.rebound).toBe(true);
		expect(dirname(target.path)).toBe(getDefaultSessionDir(cwd));
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("opens the session where it is when the user declines", async () => {
		const { cwd, sessionFile, readIdentity } = sameRepoElsewhere();

		const target = await resolveResumeTarget({
			sessionPath: sessionFile,
			cwd,
			readIdentity,
			confirm: async () => false,
		});

		expect(target).toEqual({ path: sessionFile, rebound: false });
		expect(existsSync(sessionFile)).toBe(true);
	});

	it("never asks for a different repository or for the current directory's own session", async () => {
		const { cwd, sessionFile } = sameRepoElsewhere();
		const local = writeSession(getDefaultSessionDir(cwd), cwd, {
			id: "0197f6e4-0000-7000-8000-00000000000a",
			identity: RECORDED,
		});
		const confirm = async (): Promise<boolean> => {
			throw new Error("must not ask");
		};
		const other = async (dir: string) => (dir === cwd ? { rootCommits: ["d".repeat(40)] } : undefined);

		await expect(
			resolveResumeTarget({ sessionPath: sessionFile, cwd, readIdentity: other, confirm }),
		).resolves.toEqual({ path: sessionFile, rebound: false });
		await expect(
			resolveResumeTarget({ sessionPath: local, cwd, readIdentity: async () => RECORDED, confirm }),
		).resolves.toEqual({ path: local, rebound: false });
	});

	it("reports the process that still holds the session instead of moving it", async () => {
		const { oldCwd, cwd, sessionFile, readIdentity } = sameRepoElsewhere();
		const hold = holdSessionFile(sessionFile, SESSION_ID, { cwd: oldCwd, expectExisting: true });

		await expect(
			resolveResumeTarget({ sessionPath: sessionFile, cwd, readIdentity, confirm: async () => true }),
		).rejects.toBeInstanceOf(SessionHeldError);
		hold.release();
		expect(existsSync(sessionFile)).toBe(true);
	});
});

async function movedRealRepository() {
	const root = tempDir();
	const oldCwd = join(root, "old", "repo");
	const cwd = join(root, "new", "repo");
	makeRepo(oldCwd, "moved\n");
	const sessionFile = writeSession(getDefaultSessionDir(oldCwd), oldCwd, {
		identity: await readRepositoryIdentity(oldCwd),
	});
	mkdirSync(dirname(cwd), { recursive: true });
	renameSync(oldCwd, cwd);
	return { oldCwd, cwd, sessionFile };
}

async function continueIn(cwd: string, appMode: "interactive" | "print", answer?: string) {
	const child = spawnModuleChild(
		[
			"process.stdin.isTTY = true;",
			"process.stdout.isTTY = true;",
			`const { createSessionManager } = await import(${JSON.stringify(mainUrl)});`,
			`const sm = await createSessionManager({ continue: true }, ${JSON.stringify(cwd)}, undefined, undefined, ${JSON.stringify(appMode)});`,
			"const result = { file: sm.getSessionFile(), cwd: sm.getCwd(), entries: sm.getEntries().map((e) => e.id) };",
			'process.stdout.write("RESULT " + JSON.stringify(result) + "\\n", () => process.exit(0));',
		].join("\n"),
		{},
		cwd,
	);
	if (answer !== undefined) child.send(answer);
	const line = await child.line("RESULT ");
	await child.exit();
	return {
		output: child.output(),
		session: JSON.parse(line.slice("RESULT ".length)) as { file: string; cwd: string; entries: string[] },
	};
}

describe("issue #2184 --continue after the repository moved", () => {
	it("offers the moved session and continues it in place on y", async () => {
		const { oldCwd, cwd, sessionFile } = await movedRealRepository();

		const { output, session } = await continueIn(cwd, "interactive", "y\n");

		expect(output).toContain(REBIND_PROMPT);
		expect(output).toContain(oldCwd);
		expect(session.cwd).toBe(cwd);
		expect(dirname(session.file)).toBe(getDefaultSessionDir(cwd));
		expect(session.entries).toEqual(["u1", "a1", "r1"]);
		expect(existsSync(sessionFile)).toBe(false);
	});

	it("starts a new session and leaves the moved one alone on n", async () => {
		const { cwd, sessionFile } = await movedRealRepository();

		const { session } = await continueIn(cwd, "interactive", "n\n");

		expect(session.entries).toEqual([]);
		expect(existsSync(sessionFile)).toBe(true);
	});

	it("never asks without a terminal and prints the --rebind command", async () => {
		const { cwd, sessionFile } = await movedRealRepository();

		const { output, session } = await continueIn(cwd, "print");

		expect(output).not.toContain(REBIND_PROMPT);
		expect(output).toContain(`--rebind '${SESSION_ID}'`);
		expect(session.entries).toEqual([]);
		expect(existsSync(sessionFile)).toBe(true);
	});

	it("continues the current project's own session without asking", async () => {
		const { cwd } = await movedRealRepository();
		const local = writeSession(getDefaultSessionDir(cwd), cwd, {
			id: "0197f6e4-0000-7000-8000-00000000000b",
			timestamp: "2026-09-27T01:00:00.000Z",
		});

		const { output, session } = await continueIn(cwd, "interactive");

		expect(output).not.toContain(REBIND_PROMPT);
		expect(session.file).toBe(local);
	});
});
