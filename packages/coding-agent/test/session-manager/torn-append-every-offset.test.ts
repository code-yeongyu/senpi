import type { AssistantMessage } from "@earendil-works/pi-ai";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const fault = vi.hoisted(() => ({ keepBytes: undefined as number | undefined }));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => {
			const keep = fault.keepBytes;
			if (keep === undefined || typeof args[1] !== "string") return actual.appendFileSync(...args);
			fault.keepBytes = undefined;
			actual.appendFileSync(args[0], Buffer.from(args[1]).subarray(0, keep));
			throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		},
	};
});

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(() => {
	fault.keepBytes = undefined;
	for (const manager of managers.splice(0)) manager.dispose();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function assistant(text: string): AssistantMessage {
	return {
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
	};
}

function transcript(register = true): { root: string; file: string; manager: SessionManager } {
	const root = mkdtempSync(join(tmpdir(), "senpi-every-offset-"));
	const manager = SessionManager.create(root, join(root, "sessions"));
	if (register) {
		roots.push(root);
		managers.push(manager);
	}
	manager.appendMessage({ role: "user", content: "u1", timestamp: 1 });
	manager.appendMessage(assistant("a1"));
	manager.appendMessage({ role: "user", content: "u2", timestamp: 3 });
	manager.appendMessage(assistant("a2"));
	const file = manager.getSessionFile();
	if (!file) throw new Error("missing transcript");
	return { root, file, manager };
}

function reopen(file: string): SessionManager {
	const manager = SessionManager.open(file);
	managers.push(manager);
	return manager;
}

describe("torn transcript byte boundaries (senpi#4295)", () => {
	// Every cut through a line is set aside through the fsynced backup writer, so the offsets are separate cases: one
	// loop over all of them paid every backup inside a single test's time budget.
	const fixture = transcript(false);
	const bytes = readFileSync(fixture.file);
	let end = 0;
	const entryEnds = bytes
		.toString("utf8")
		.trimEnd()
		.split("\n")
		.map((line) => {
			end += Buffer.byteLength(line) + 1;
			return { end: end - 1, entry: JSON.parse(line) as { type: string; id: string } };
		})
		.filter(({ entry }) => entry.type !== "session");
	afterAll(() => {
		fixture.manager.dispose();
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it.each(Array.from({ length: bytes.length + 1 }, (_, cut) => cut))(
		"opens the %i-byte prefix of a four-message transcript and appends without losing whole entries",
		(cut) => {
			const root = mkdtempSync(join(tmpdir(), "senpi-every-offset-cut-"));
			roots.push(root);
			const path = join(root, `cut-${cut}.jsonl`);
			writeFileSync(path, bytes.subarray(0, cut));
			const expected = entryEnds.filter(({ end: entryEnd }) => entryEnd <= cut).map(({ entry }) => entry.id);
			const manager = reopen(path);
			expect(
				manager.getEntries().map((entry) => entry.id),
				`cut ${cut}`,
			).toEqual(expected);
			const next = manager.appendMessage({ role: "user", content: "retry", timestamp: 4 });
			expect(
				reopen(path)
					.getEntries()
					.map((entry) => entry.id),
				`cut ${cut} after append`,
			).toEqual([...expected, next]);
		},
	);

	it.each(Array.from({ length: 159 }, (_, offset) => offset))(
		"retries in the same process after an ENOSPC append at byte %i",
		(offset) => {
			const { file, manager } = transcript();
			const prefix = manager.getEntries().map((entry) => entry.id);
			fault.keepBytes = offset;
			expect(() => manager.appendCustomEntry("torn", { pad: "x".repeat(160) })).toThrow("ENOSPC");
			expect(manager.getEntries().map((entry) => entry.id)).toEqual(prefix);
			const next = manager.appendCustomEntry("retry");
			const following = manager.appendMessage({ role: "user", content: "after retry", timestamp: 5 });
			expect(
				reopen(file)
					.getEntries()
					.map((entry) => entry.id),
			).toEqual([...prefix, next, following]);
			const disk = readFileSync(file, "utf8").trimEnd().split("\n");
			expect(disk.map((line) => JSON.parse(line)).filter((entry) => entry.type !== "session")).toHaveLength(6);
		},
	);
});
