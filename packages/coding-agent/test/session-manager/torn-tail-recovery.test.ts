import type { AssistantMessage } from "@earendil-works/pi-ai";
import type * as FsModule from "fs";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionRecovery, SessionManager } from "../../src/core/session-manager.ts";
import { backupTornBytes } from "../../src/core/session-write-recovery.ts";

const fault = vi.hoisted(() => ({
	appendKeepBytes: undefined as number | undefined,
	failWritesMatching: undefined as RegExp | undefined,
}));

function noSpace(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			const [path, data] = args;
			const keep = fault.appendKeepBytes;
			if (keep === undefined || typeof data !== "string") return actual.appendFileSync(...args);
			fault.appendKeepBytes = undefined;
			actual.appendFileSync(path, data.slice(0, keep));
			throw noSpace();
		},
		openSync: (...args: Parameters<typeof actual.openSync>) => {
			const [file] = args;
			if (typeof file !== "string" || fault.failWritesMatching?.test(file) !== true) return actual.openSync(...args);
			fault.failWritesMatching = undefined;
			throw noSpace();
		},
	};
});

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "test",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 2,
});

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	fault.appendKeepBytes = undefined;
	fault.failWritesMatching = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function savedSession(): { readonly file: string; readonly prefix: string } {
	const dir = mkdtempSync(join(tmpdir(), "senpi-torn-tail-"));
	tempDirs.push(dir);
	const session = SessionManager.create(dir, join(dir, "sessions"));
	session.appendMessage({ role: "user", content: "hello", timestamp: 1 });
	session.appendMessage(assistant("hi"));
	const file = session.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	return { file, prefix: readFileSync(file, "utf8") };
}

function backups(file: string): string[] {
	return readdirSync(dirname(file))
		.filter((name) => name.startsWith(`${basename(file)}.torn-`))
		.map((name) => readFileSync(join(dirname(file), name), "utf8"));
}

function recoveriesOf(session: SessionManager): SessionRecovery[] {
	const seen: SessionRecovery[] = [];
	session.onRecovery((recovery) => seen.push(recovery));
	return seen;
}

const FRAGMENT = '{"type":"message","id":"torn","parentId":null,"message":{"role":"user","con';

describe("SessionManager torn tail recovery", () => {
	it.each(["disk_full", "write_failed", "unknown"] as const)(
		"displays a home-relative backup path for the %s notice without exposing the absolute home (senpi#4295)",
		(cause) => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-recovery-home-"));
			tempDirs.push(dir);
			const home = join(dir, "Users", "testuser");
			vi.stubEnv("HOME", home);
			vi.stubEnv("USERPROFILE", home);
			for (const sessionDir of [
				join(home, "sessions"),
				join(dir, "Users", "testuser-other", "sessions"),
				join(dir, "other", "sessions"),
			]) {
				mkdirSync(sessionDir, { recursive: true });
				const recovery = backupTornBytes(join(sessionDir, "test.jsonl"), Buffer.from(FRAGMENT), cause);

				expect(recovery.backupPath.startsWith(sessionDir)).toBe(true);
				expect(recovery.notice).not.toContain(dir);
				expect(recovery.notice).not.toContain("testuser");
				if (sessionDir === join(home, "sessions")) {
					expect(recovery.notice).toContain(`~/sessions/${basename(recovery.backupPath)}`);
				} else {
					expect(recovery.notice).not.toContain(recovery.backupPath);
					expect(recovery.notice).not.toContain("~");
				}
			}
		},
	);

	it("keeps an incomplete multibyte tail byte-exact when opening (senpi#4295)", () => {
		const { file, prefix } = savedSession();
		const fragment = Buffer.concat([Buffer.from(FRAGMENT), Buffer.from([0xed, 0x95])]);
		appendFileSync(file, fragment);

		const seen = recoveriesOf(SessionManager.open(file));

		expect(seen).toHaveLength(1);
		const recovery = seen[0];
		if (!recovery) throw new Error("expected a recovery for the incomplete multibyte tail");
		expect(readFileSync(recovery.backupPath)).toEqual(fragment);
		expect(recovery.droppedBytes).toBe(fragment.length);
		expect(readFileSync(file, "utf8")).toBe(prefix);
	});

	it.each([false, true])(
		"keeps the disk-full cause when reloading after a failed append, deferred=%s (senpi#4295)",
		(deferred) => {
			const { file } = savedSession();
			const session = SessionManager.open(file);
			const seen = recoveriesOf(session);
			fault.appendKeepBytes = 20;
			expect(() => session.appendCustomEntry("torn", { n: 1 })).toThrow("ENOSPC");
			if (deferred) fault.failWritesMatching = /\.torn-/;

			session.reloadFromDisk();
			session.appendCustomEntry("after", { n: 2 });

			expect(seen.map((recovery) => recovery.cause)).toEqual(["disk_full"]);
		},
	);

	it("does not carry a failed-write cause to a different session file (senpi#4295)", () => {
		const { file } = savedSession();
		const session = SessionManager.open(file);
		const seen = recoveriesOf(session);
		fault.appendKeepBytes = 20;
		expect(() => session.appendCustomEntry("torn", { n: 1 })).toThrow("ENOSPC");
		const other = savedSession();
		appendFileSync(other.file, FRAGMENT);

		session.setSessionFile(other.file);

		expect(seen.map((recovery) => recovery.cause)).toEqual(["unknown"]);
	});

	it("sets a torn final line aside once when the session opens, and keeps the rest byte for byte", () => {
		// Given a saved session whose last line was torn by an interrupted write
		const { file, prefix } = savedSession();
		appendFileSync(file, FRAGMENT);

		// When it is opened, and opened again
		const first = recoveriesOf(SessionManager.open(file));
		const second = recoveriesOf(SessionManager.open(file));

		// Then the fragment is in one backup, the file holds only complete lines, and one recovery was reported
		expect(backups(file)).toEqual([FRAGMENT]);
		expect(readFileSync(file, "utf8")).toBe(prefix);
		expect(first.map(({ cause, droppedBytes }) => ({ cause, droppedBytes }))).toEqual([
			{ cause: "unknown", droppedBytes: FRAGMENT.length },
		]);
		expect(first[0]?.notice).toContain("wasn't saved completely");
		expect(second).toEqual([]);
	});

	it("sets the fragment of a failed append aside before the next append, with the disk-full cause", () => {
		// Given an open session whose append ran out of space after 20 bytes
		const { file, prefix } = savedSession();
		const session = SessionManager.open(file);
		const seen = recoveriesOf(session);
		fault.appendKeepBytes = 20;
		expect(() => session.appendCustomEntry("torn", { n: 1 })).toThrow("ENOSPC");
		const fragment = readFileSync(file, "utf8").slice(prefix.length);

		// When the next append succeeds
		session.appendCustomEntry("after", { n: 2 });

		// Then the fragment was set aside and the user is told the disk was full
		expect(backups(file)).toEqual([fragment]);
		expect(seen.map((recovery) => recovery.cause)).toEqual(["disk_full"]);
		expect(seen[0]?.notice).toContain("because the disk was full");
		expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
	});

	it("opens without touching the file while the backup cannot be written, and sets the tail aside before the next append", () => {
		// Given a torn final line and a volume that is still full when the session opens
		const { file, prefix } = savedSession();
		appendFileSync(file, FRAGMENT);
		fault.failWritesMatching = /\.torn-/;

		// When it opens and then appends once there is room
		const session = SessionManager.open(file);
		const seen = recoveriesOf(session);
		const atOpen = readFileSync(file, "utf8");
		session.appendCustomEntry("after", { n: 1 });

		// Then nothing was lost while the disk was full, and the next line stands on its own
		expect(atOpen).toBe(`${prefix}${FRAGMENT}`);
		expect(backups(file)).toEqual([FRAGMENT]);
		expect(readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
		expect(readFileSync(file, "utf8").slice(prefix.length)).toMatch(/^\{"type":"custom"[^\n]*\n$/);
		expect(seen.map((recovery) => recovery.cause)).toEqual(["unknown"]);
	});

	it("continues the most recent session without gluing the next append onto a torn tail", () => {
		// Given the most recent session in a directory ends in a torn line
		const { file, prefix } = savedSession();
		appendFileSync(file, FRAGMENT);
		const cwd = dirname(dirname(file));

		// When it is continued (`-c`) and the next entry is appended
		const session = SessionManager.continueRecent(cwd, dirname(file));
		const seen = recoveriesOf(session);
		session.appendCustomEntry("after", { n: 1 });

		// Then the fragment was set aside and the new entry is a complete line of its own
		expect(session.getSessionFile()).toBe(file);
		expect(backups(file)).toEqual([FRAGMENT]);
		expect(readFileSync(file, "utf8").slice(prefix.length)).toMatch(/^\{"type":"custom"[^\n]*\n$/);
		expect(seen).toHaveLength(1);
	});
});
