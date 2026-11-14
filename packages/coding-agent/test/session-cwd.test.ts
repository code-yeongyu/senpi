import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	SessionCwdNotDirectoryError,
} from "../src/core/session-cwd.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("supports overriding the effective cwd when opening a session", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-override-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-runtime-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});

	it("#given a stored cwd that exists but is a file #when the runtime is created #then a controlled SessionCwdNotDirectoryError naming it is thrown before runtime creation", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-file");
		const fileCwd = join(fallbackCwd, "hostname");
		writeFileSync(fileCwd, "a file, not a folder\n");
		const sessionDir = createTempDir("pi-session-cwd-file-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, fileCwd);

		const sessionManager = SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		const refused = await createAgentSessionRuntime(createRuntime, {
			cwd: fallbackCwd,
			agentDir: fallbackCwd,
			sessionManager,
		}).catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(SessionCwdNotDirectoryError);
		expect((refused as { issue?: unknown }).issue).toMatchObject({ sessionCwd: fileCwd });
		expect(createRuntimeCalled).toBe(false);
	});
});
