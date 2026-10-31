import type { AssistantMessage } from "@earendil-works/pi-ai";
import type * as FsModule from "fs";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

/** A full disk part-way through creating a fork or a branch must leave no fork file in the session list (senpi#4295). */

const fault = vi.hoisted(() => ({ budget: undefined as number | undefined }));

function noSpace(): Error {
	return Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
}

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof FsModule>();
	/** Lands what fits in the remaining budget, then fails the write the way a full volume does. */
	function limited<T extends unknown[]>(write: (target: T[0], data: string, ...rest: unknown[]) => void) {
		return (target: T[0], data: unknown, ...rest: unknown[]) => {
			if (fault.budget === undefined || typeof data !== "string") return write(target, data as string, ...rest);
			if (data.length <= fault.budget) {
				fault.budget -= data.length;
				return write(target, data, ...rest);
			}
			const landed = data.slice(0, fault.budget);
			fault.budget = undefined;
			if (landed.length > 0) write(target, landed, ...rest);
			throw noSpace();
		};
	}
	return {
		...actual,
		appendFileSync: limited((target, data, ...rest) =>
			actual.appendFileSync(target as FsModule.PathOrFileDescriptor, data, ...(rest as [])),
		),
		writeFileSync: limited((target, data, ...rest) =>
			actual.writeFileSync(target as FsModule.PathOrFileDescriptor, data, ...(rest as [])),
		),
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

const roots: string[] = [];

afterEach(() => {
	fault.budget = undefined;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function savedSession(): { readonly root: string; readonly session: SessionManager; readonly file: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-fork-full-"));
	roots.push(root);
	const session = SessionManager.create(root, join(root, "sessions"));
	for (let turn = 0; turn < 3; turn++) {
		session.appendMessage({ role: "user", content: `question ${turn} ${"x".repeat(200)}`, timestamp: 1 });
		session.appendMessage(assistant(`answer ${turn} ${"y".repeat(200)}`));
	}
	const file = session.getSessionFile();
	if (!file) throw new Error("test setup: persisted session has no file");
	return { root, session, file };
}

function captureError(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("creating a session copy on a full disk", () => {
	it("leaves no fork file behind when forkFrom runs out of space part-way", () => {
		// Given a saved session and a target session directory
		const { root, file } = savedSession();
		const forkDir = join(root, "forks");
		const failures: unknown[] = [];

		// When the disk fills up after each possible amount of the fork has been written
		for (const budget of [0, 150, 600, 1200]) {
			fault.budget = budget;
			failures.push(captureError(() => SessionManager.forkFrom(file, root, forkDir)));
			fault.budget = undefined;
		}

		// Then every attempt reported the full disk and no partial fork (or temp file) is left in the directory
		expect(failures.map((failure) => (failure as { code?: string } | undefined)?.code)).toEqual([
			"ENOSPC",
			"ENOSPC",
			"ENOSPC",
			"ENOSPC",
		]);
		expect(readdirSync(forkDir)).toEqual([]);
	});

	it("leaves no branch file behind when createBranchedSession runs out of space part-way", () => {
		// Given a saved session
		const { root, session } = savedSession();
		const leaf = session.getLeafId();
		if (!leaf) throw new Error("test setup: no leaf");
		const before = readdirSync(join(root, "sessions")).sort();

		// When the branch copy runs out of space part-way
		fault.budget = 300;
		const failure = captureError(() => session.createBranchedSession(leaf));
		fault.budget = undefined;

		// Then the failure surfaced and the session directory holds exactly what it held before
		expect(failure).toMatchObject({ code: "ENOSPC" });
		expect(readdirSync(join(root, "sessions")).sort()).toEqual(before);
	});
});
