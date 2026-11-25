import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { RESIDENT_STRING_PREFIX } from "../../src/core/session-resident-store.ts";

// senpi#3968: opening a session must keep a content-free index of its entries and read bodies back by byte range.
// The session is shaped like a long tool run (prompt, tool call, 16 KiB tool result, answer per turn) and large
// enough (~25 MB) that a retained body shows up as orders of magnitude over the ceiling below.
const TURNS = 1500;
const RESULT_CHARS = 16 * 1024;
// A string of at least this many characters is paged out of the resident mirror (SESSION_PAGE_MIN_CHARS). What stays
// resident per entry is its skeleton (ids, roles, usage, short text) and strings below this size, so the mirror's
// serialized size is bounded per entry, never by content: 1 KiB per entry is ~4x this fixture's largest skeleton and
// ~4x below the file's own bytes per entry, so a single retained 16 KiB body per turn breaks it.
const PAGE_MIN_CHARS = 1024;
const MIRROR_BYTES_PER_ENTRY = 1024;

const resultText = (turn: number) => `${turn}:${"r".repeat(RESULT_CHARS)}`;

function assistant(content: unknown[]) {
	return {
		role: "assistant",
		content,
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
		timestamp: 1,
	};
}

function writeToolSession(dir: string): { file: string; entries: number } {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id: "s3968", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
	];
	let parentId: string | null = null;
	const push = (message: unknown) => {
		const id = lines.length.toString(16).padStart(8, "0");
		lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }));
		parentId = id;
	};
	for (let turn = 0; turn < TURNS; turn++) {
		const callId = `call-${turn}`;
		push({ role: "user", content: `turn ${turn}: read the file`, timestamp: 1 });
		push(assistant([{ type: "toolCall", id: callId, name: "read", arguments: { path: `file-${turn}.txt` } }]));
		push({
			role: "toolResult",
			toolCallId: callId,
			toolName: "read",
			content: [{ type: "text", text: resultText(turn) }],
			isError: false,
			timestamp: 1,
		});
		push(assistant([{ type: "text", text: `turn ${turn}: done` }]));
	}
	const file = join(dir, "2026-01-01T00-00-00-000Z_s3968.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return { file, entries: lines.length - 1 };
}

function residentMirror(manager: SessionManager): unknown[] {
	return (manager as unknown as { fileEntries: unknown[] }).fileEntries;
}

function longestString(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value !== "object" || value === null) return 0;
	let longest = 0;
	for (const item of Object.values(value)) longest = Math.max(longest, longestString(item));
	return longest;
}

function expectBodiesPagedOut(manager: SessionManager, entries: number): void {
	const mirror = residentMirror(manager);
	expect(longestString(mirror)).toBeLessThan(PAGE_MIN_CHARS);
	expect(JSON.stringify(mirror).length).toBeLessThanOrEqual(entries * MIRROR_BYTES_PER_ENTRY);
	// The bodies are not parked in the resident string store instead.
	expect(manager.getResidentStore().size().approxBytes).toBe(0);
}

function toolResultTexts(manager: SessionManager): string[] {
	return manager
		.buildSessionContext()
		.messages.flatMap((message) =>
			message.role === "toolResult"
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		);
}

describe("senpi#3968 opening a large session keeps entry bodies on disk", () => {
	let dir: string;

	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "s3968-")));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it.each([
		["open", async (file: string) => SessionManager.open(file)],
		["openAsync", (file: string) => SessionManager.openAsync(file)],
	])("%s keeps a content-free mirror and reads bodies back on demand", async (_name, open) => {
		const { file, entries } = writeToolSession(dir);
		expect(statSync(file).size).toBeGreaterThan(entries * 4 * 1024);

		const manager = await open(file);
		try {
			expectBodiesPagedOut(manager, entries);

			expect(manager.getEntries()).toHaveLength(entries);
			expect(JSON.stringify(manager.getBranch())).not.toContain(RESIDENT_STRING_PREFIX);
			const texts = toolResultTexts(manager);
			expect(texts).toHaveLength(TURNS);
			expect(texts[0]).toBe(resultText(0));
			expect(texts[TURNS - 1]).toBe(resultText(TURNS - 1));

			// Reading bodies does not pull them back into the mirror; the views go when the session settles.
			manager.dropMaterializedCaches();
			expectBodiesPagedOut(manager, entries);
		} finally {
			manager.dispose();
		}
	});

	// A full read must not build a second copy of every body: each paged string is decoded from its own bytes, never by
	// re-parsing its whole line (which held the entry and the escaped text beside the string). Bodies carry escapes, so
	// this is not a property of an escape-free fixture.
	it("a full read decodes every paged body from its own bytes, escapes included", () => {
		const escaped = (turn: number) =>
			`${turn}\tconst label = "tool \\"out\\"";\n// C:\\work\\f-${turn}.ts — ü 한\n`.repeat(400);
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "s3968e", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
		];
		let parentId: string | null = null;
		for (let turn = 0; turn < 50; turn++) {
			const id = (turn + 1).toString(16).padStart(8, "0");
			const message = {
				role: "toolResult",
				toolCallId: `call-${turn}`,
				toolName: "read",
				content: [{ type: "text", text: escaped(turn) }],
				isError: false,
				timestamp: 1,
			};
			lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }));
			parentId = id;
		}
		const file = join(dir, "2026-01-01T00-00-00-000Z_s3968e.jsonl");
		writeFileSync(file, `${lines.join("\n")}\n`);

		const manager = SessionManager.open(file);
		try {
			const texts = manager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? entry.message.content : [],
				)
				.flatMap((part) => (part.type === "text" ? [part.text] : []));
			expect(texts).toEqual(Array.from({ length: 50 }, (_, turn) => escaped(turn)));
			const stats = manager.getResidentStoreStats();
			expect(stats.pagedCount).toBe(50);
			expect(stats.pageWholeLineReads ?? 0).toBe(0);
		} finally {
			manager.dispose();
		}
	});
});
