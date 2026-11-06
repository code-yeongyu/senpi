import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

const hooks = vi.hoisted(() => ({
	beforeClose: undefined as (() => void) | undefined,
	writeFails: undefined as Error | undefined,
	appendFails: undefined as Error | undefined,
	cutFails: false,
	keepWholeLine: false,
}));

vi.mock("fs/promises", async (importOriginal) => {
	const real = await importOriginal<typeof import("fs/promises")>();
	return {
		...real,
		appendFile: async (...args: Parameters<typeof real.appendFile>) => {
			const failure = hooks.appendFails;
			if (failure === undefined || typeof args[1] !== "string") return real.appendFile(...args);
			hooks.appendFails = undefined;
			const keep = hooks.keepWholeLine ? args[1].indexOf("\n") + 18 : Math.floor(args[1].length / 2);
			await real.appendFile(args[0], args[1].slice(0, keep));
			throw failure;
		},
		truncate: async (...args: Parameters<typeof real.truncate>) => {
			if (!hooks.cutFails) return real.truncate(...args);
			hooks.cutFails = false;
			throw Object.assign(new Error("EIO"), { code: "EIO" });
		},
		open: async (...args: Parameters<typeof real.open>) => {
			const handle = await real.open(...args);
			const writeFile = handle.writeFile.bind(handle);
			handle.writeFile = (async (data: string) => {
				const failure = hooks.writeFails;
				if (failure === undefined) return writeFile(data);
				hooks.writeFails = undefined;
				await writeFile(data.slice(0, Math.floor(data.length / 2)));
				throw failure;
			}) as typeof handle.writeFile;
			const close = handle.close.bind(handle);
			handle.close = async () => {
				hooks.beforeClose?.();
				await close();
			};
			return handle;
		},
	};
});

const roots: string[] = [];

afterEach(() => {
	hooks.beforeClose = undefined;
	hooks.writeFails = undefined;
	hooks.appendFails = undefined;
	hooks.cutFails = false;
	hooks.keepWholeLine = false;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshSession(): { manager: SessionManager; file: string } {
	const root = mkdtempSync(join(tmpdir(), "senpi-header-write-"));
	roots.push(root);
	const manager = SessionManager.create(root, join(root, "sessions"));
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("no session file");
	return { manager, file };
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function linesOnDisk(file: string): Record<string, unknown>[] {
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
}

function idsOnDisk(file: string): string[] {
	return linesOnDisk(file)
		.filter((line) => line.type !== "session")
		.map((line) => String(line.id));
}

describe("persistHeaderNow's asynchronous header write", () => {
	it("retries an exact failed cut-back before replaying a batch that landed whole lines too", async () => {
		const { manager, file } = freshSession();
		manager.appendCustomEntry("before");
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendCustomEntry("during-one");
			manager.appendCustomEntry("during-two");
			hooks.appendFails = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			hooks.keepWholeLine = true;
			hooks.cutFails = true;
		};
		await expect(manager.persistHeaderNow()).rejects.toMatchObject({ code: "ENOSPC" });
		expect(readFileSync(file, "utf8")).toContain('"customType":"during-one"');
		manager.appendCustomEntry("after");
		expect(idsOnDisk(file)).toEqual(manager.getEntries().map((entry) => entry.id));
	});

	it.each([false, true])("keeps header ownership across compaction, catch-up failure=%s", async (fails) => {
		const { manager, file } = freshSession();
		const first = manager.appendCustomEntry("before");
		let compaction = "";
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			compaction = manager.appendCompaction("summary", first, 1);
			if (fails) hooks.appendFails = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		};
		const writing = manager.persistHeaderNow();
		if (fails) await expect(writing).rejects.toMatchObject({ code: "ENOSPC" });
		else await writing;
		expect(manager.isTranscriptFlushed()).toBe(true);
		const next = manager.appendCustomEntry("after");
		expect(idsOnDisk(file)).toEqual([first, compaction, next]);
		expect(idsOnDisk(file)).toEqual(
			SessionManager.open(file)
				.getEntries()
				.map((entry) => entry.id),
		);
	});

	it("does not replay a failed catch-up after discarding and recreating its startup-only file", async () => {
		const { manager, file } = freshSession();
		manager.appendCustomEntry("before", {}, { startupBookkeeping: true });
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendCustomEntry("during-close", {}, { startupBookkeeping: true });
			hooks.appendFails = Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		};
		await expect(manager.persistHeaderNow()).rejects.toMatchObject({ code: "ENOSPC" });
		expect(await manager.discardHeaderOnlyFile()).toBe(true);
		expect(existsSync(file)).toBe(false);
		manager.appendMessage({ role: "user", content: "first flush", timestamp: 1 });
		manager.appendMessage(assistant("next append"));
		expect(idsOnDisk(file)).toEqual(manager.getEntries().map((entry) => entry.id));
	});

	it("writes the entries persisted while its file handle closes before the transcript counts as flushed", async () => {
		const { manager, file } = freshSession();
		manager.appendCustomEntry("before", { n: 0 });
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendCustomEntry("during-close", { n: 1 });
		};
		await manager.persistHeaderNow();
		expect(manager.isTranscriptFlushed()).toBe(true);
		manager.appendCustomEntry("after", { n: 2 });
		expect(linesOnDisk(file).map((line) => (line.type === "session" ? "session" : line.customType))).toEqual([
			"session",
			"before",
			"during-close",
			"after",
		]);
	});

	it("owns the file while it runs: an assistant message appended meanwhile lands once, in order", async () => {
		const { manager, file } = freshSession();
		// A setup entry stays buffered: the first user message itself would flush the file (#10000).
		manager.appendCustomEntry("setup", { n: 0 });
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendMessage(assistant("a1-during-close"));
		};

		await manager.persistHeaderNow();
		manager.appendMessage({ role: "user", content: "u2", timestamp: 2 });

		expect(manager.isTranscriptFlushed()).toBe(true);
		expect(idsOnDisk(file)).toEqual(manager.getEntries().map((entry) => entry.id));
		expect(manager.getEntries().map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual(
			["custom", "assistant", "user"],
		);
	});

	it("removes the file it part-wrote when it fails, so the next write persists every entry memory holds", async () => {
		const { manager, file } = freshSession();
		// A setup entry stays buffered: the first user message itself would flush the file (#10000).
		manager.appendCustomEntry("setup", { n: 0 });
		manager.appendCustomEntry("pad", { text: "y".repeat(400) });
		hooks.writeFails = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });

		const headerWrite = manager.persistHeaderNow();
		manager.appendMessage(assistant("a1-in-flight"));
		await expect(headerWrite).rejects.toMatchObject({ code: "ENOSPC" });

		expect(existsSync(file)).toBe(false);
		expect(manager.isTranscriptFlushed()).toBe(false);
		manager.appendMessage(assistant("a2-after-space-returns"));
		expect(manager.isTranscriptFlushed()).toBe(true);
		expect(idsOnDisk(file)).toEqual(manager.getEntries().map((entry) => entry.id));
		expect(manager.getEntries()).toHaveLength(4);
	});

	it("keeps the header and entries already on disk when only the catch-up append fails, and writes the rest next", async () => {
		// Given a header write whose catch-up append (entries persisted while its handle closed) runs out of space
		const { manager, file } = freshSession();
		manager.appendCustomEntry("before", { n: 0 });
		hooks.beforeClose = () => {
			hooks.beforeClose = undefined;
			manager.appendCustomEntry("during-close", { n: 1 });
			hooks.appendFails = Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		};

		// When the header write settles and, once there is space, the next entry is appended
		await expect(manager.persistHeaderNow()).rejects.toMatchObject({ code: "ENOSPC" });
		const kept = existsSync(file)
			? linesOnDisk(file).map((line) => (line.type === "session" ? "session" : line.customType))
			: [];
		manager.appendCustomEntry("after", { n: 2 });

		// Then the written prefix stayed on disk, and the file then holds every entry memory holds, once, in order
		expect(kept).toEqual(["session", "before"]);
		expect(manager.isTranscriptFlushed()).toBe(true);
		expect(linesOnDisk(file).map((line) => (line.type === "session" ? "session" : line.customType))).toEqual([
			"session",
			"before",
			"during-close",
			"after",
		]);
		expect(idsOnDisk(file)).toEqual(manager.getEntries().map((entry) => entry.id));
	});
});
