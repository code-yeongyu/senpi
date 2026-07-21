import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager materialized-view cache", () => {
	let materializeSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		materializeSpy = vi.spyOn(ResidentStringStore.prototype, "materialize");
	});

	afterEach(() => {
		materializeSpy.mockRestore();
	});

	describe("getEntries()", () => {
		it("repeat reads without mutation perform zero extra materialize calls", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const first = session.getEntries();
			expect(first).toHaveLength(2);
			materializeSpy.mockClear();

			const second = session.getEntries();
			expect(second).toHaveLength(2);
			expect(second[0].id).toBe(first[0].id);
			expect(materializeSpy).not.toHaveBeenCalled();
		});

		it("append invalidates the cache", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.getEntries();
			materializeSpy.mockClear();

			session.appendMessage(assistantMsg("hi"));
			session.getEntries();
			expect(materializeSpy.mock.calls.length).toBeGreaterThan(0);
		});

		it("setSessionFile invalidates the cache", () => {
			const dir = mkdtempSync(join(tmpdir(), "sm-materialize-cache-"));
			try {
				const session = SessionManager.create(dir, dir);
				session.appendMessage(userMsg("hello"));
				session.appendMessage(assistantMsg("hi"));
				const file = session.getSessionFile()!;

				session.getEntries();
				materializeSpy.mockClear();
				session.getEntries();
				expect(materializeSpy).not.toHaveBeenCalled();

				session.setSessionFile(file);
				session.getEntries();
				expect(materializeSpy.mock.calls.length).toBeGreaterThan(0);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it("newSession invalidates the cache", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.getEntries();
			materializeSpy.mockClear();

			session.newSession();
			expect(session.getEntries()).toHaveLength(0);
			session.appendMessage(userMsg("fresh"));
			session.getEntries();
			expect(materializeSpy.mock.calls.length).toBeGreaterThan(0);
		});
	});

	describe("getBranch()", () => {
		it("repeat no-arg reads without mutation perform zero extra materialize calls", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const first = session.getBranch();
			expect(first).toHaveLength(2);
			materializeSpy.mockClear();

			const second = session.getBranch();
			expect(second).toHaveLength(2);
			expect(materializeSpy).not.toHaveBeenCalled();
		});

		it("branch() invalidates the no-arg cache", () => {
			const session = SessionManager.inMemory();
			const id1 = session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			session.getBranch();
			materializeSpy.mockClear();

			session.branch(id1);
			const branch = session.getBranch();
			expect(branch).toHaveLength(1);
			expect(materializeSpy.mock.calls.length).toBeGreaterThan(0);
		});

		it("explicit fromId bypasses the cache", () => {
			const session = SessionManager.inMemory();
			const id1 = session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			session.getBranch(id1);
			materializeSpy.mockClear();
			session.getBranch(id1);
			expect(materializeSpy.mock.calls.length).toBeGreaterThan(0);
		});
	});

	describe("getSessionName()", () => {
		it("is O(1): repeat reads perform zero materialize calls", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendSessionInfo("My Session");
			expect(session.getSessionName()).toBe("My Session");
			materializeSpy.mockClear();

			expect(session.getSessionName()).toBe("My Session");
			expect(materializeSpy).not.toHaveBeenCalled();
		});

		it("empty name clears the title", () => {
			const session = SessionManager.inMemory();
			session.appendMessage(userMsg("hello"));
			session.appendSessionInfo("My Session");
			expect(session.getSessionName()).toBe("My Session");

			session.appendSessionInfo("");
			expect(session.getSessionName()).toBeUndefined();
		});
	});
});
