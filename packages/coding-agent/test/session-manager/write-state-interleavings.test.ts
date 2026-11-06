import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const fault = vi.hoisted(() => ({
	beforeClose: undefined as (() => void) | undefined,
	asyncAppend: false,
	syncAppend: false,
}));

function noSpace(): Error {
	return Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
}

vi.mock("fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs/promises")>();
	return {
		...actual,
		appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
			if (!fault.asyncAppend || typeof args[1] !== "string") return actual.appendFile(...args);
			fault.asyncAppend = false;
			await actual.appendFile(args[0], args[1].slice(0, 17));
			throw noSpace();
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const close = handle.close.bind(handle);
			handle.close = async () => {
				const callback = fault.beforeClose;
				fault.beforeClose = undefined;
				callback?.();
				await close();
			};
			return handle;
		},
	};
});

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			if (!fault.syncAppend || typeof args[1] !== "string") return actual.appendFileSync(...args);
			fault.syncAppend = false;
			actual.appendFileSync(args[0], args[1].slice(0, 17));
			throw noSpace();
		},
	};
});

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(() => {
	fault.beforeClose = undefined;
	fault.asyncAppend = false;
	fault.syncAppend = false;
	for (const manager of managers.splice(0)) manager.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Read only whole lines: an unsuccessful append may leave one uncommitted partial line. */
function durableIds(file: string): string[] {
	if (!existsSync(file)) return [];
	const text = readFileSync(file, "utf8");
	return text
		.slice(0, text.lastIndexOf("\n") + 1)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; id: string })
		.filter((entry) => entry.type !== "session")
		.map((entry) => entry.id);
}

describe("transcript write-state interleavings", () => {
	it.each(Array.from({ length: 32 }, (_, index) => index + 1))(
		"preserves exactly one ordered durable prefix under seed %i",
		async (seed) => {
			const root = mkdtempSync(join(tmpdir(), "senpi-write-state-"));
			roots.push(root);
			let manager = SessionManager.create(root, join(root, "sessions"));
			managers.push(manager);
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing session path");
			const accepted: string[] = [];
			let previous: string[] = [];
			let random = seed;
			const next = (): number => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
			const appendSetup = (): void => {
				accepted.push(manager.appendCustomEntry("startup", {}, { startupBookkeeping: true }));
			};
			const append = (conversation: boolean): void => {
				const id = conversation
					? manager.appendMessage({ role: "user", content: "message", timestamp: 1 })
					: manager.appendCustomEntry("startup", {}, { startupBookkeeping: true });
				accepted.push(id);
			};
			const flush = async (fails: boolean): Promise<void> => {
				if (!manager.isTranscriptFlushed()) {
					fault.beforeClose = () => {
						appendSetup();
						fault.asyncAppend = fails;
					};
				}
				try {
					await manager.persistHeaderNow();
				} catch (error) {
					expect(error).toMatchObject({ code: "ENOSPC" });
				}
			};
			// Every seed reaches the reported catch-up/discard boundary, then varies what comes next.
			appendSetup();
			await flush(true);
			for (let step = 0; step < 64; step++) {
				const operation = (next() >>> 16) % 6;
				if (operation === 0) append((next() >>> 16) % 2 === 0);
				else if (operation === 1) {
					fault.syncAppend = manager.isTranscriptFlushed();
					try {
						append(false);
					} catch (error) {
						expect(error).toMatchObject({ code: "ENOSPC" });
					}
				} else if (operation === 2) {
					if (await manager.discardHeaderOnlyFile()) previous = [];
				} else if (operation === 3 || operation === 4) await flush(operation === 4);
				else if (existsSync(file)) {
					// A reopened reader can observe only the durable prefix, not the failed writer's pending queue.
					const reader = SessionManager.open(file);
					managers.push(reader);
					expect(reader.getEntries().map((entry) => entry.id)).toEqual(durableIds(file));
					if (durableIds(file).length === accepted.length) manager = reader;
				}
				const disk = durableIds(file);
				expect(new Set(disk).size).toBe(disk.length);
				expect(disk).toEqual(accepted.slice(0, disk.length));
				expect(disk.slice(0, previous.length)).toEqual(previous);
				expect(manager.getEntries().map((entry) => entry.id)).toEqual(accepted);
				previous = disk;
			}
			fault.syncAppend = false;
			fault.asyncAppend = false;
			append(true);
			append(false);
			expect(durableIds(file)).toEqual(accepted);
			const reader = SessionManager.open(file);
			managers.push(reader);
			expect(reader.getEntries().map((entry) => entry.id)).toEqual(accepted);
		},
	);
});
