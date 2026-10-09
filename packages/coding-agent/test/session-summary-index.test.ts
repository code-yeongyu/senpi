import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSessionsDir } from "../src/config.ts";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.ts";
import { clearSessionSummaryCache, sessionSummaryStreamCount } from "../src/core/session-summary-cache.ts";

// senpi#2087: a cold process must not re-stream every unchanged session file to list /resume rows.

const INDEX_FILE = ".session-summaries.index" as const;
const HEADER_TIMESTAMP = "2026-05-01T00:00:00.000Z" as const;

function writeSession(dir: string, id: string, cwd: string, texts: readonly string[], name?: string): string {
	const base = Date.parse(HEADER_TIMESTAMP);
	const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: HEADER_TIMESTAMP, cwd })];
	if (name) lines.push(JSON.stringify({ type: "session_info", id: `${id}-info`, timestamp: HEADER_TIMESTAMP, name }));
	texts.forEach((text, index) => {
		const timeMs = base + (index + 1) * 1000;
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${id}-msg-${index}`,
				parentId: index === 0 ? null : `${id}-msg-${index - 1}`,
				timestamp: new Date(timeMs).toISOString(),
				message: { role: index % 2 === 0 ? "user" : "assistant", content: text, timestamp: timeMs },
			}),
		);
	});
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

/** Index entry basenames, last line wins, torn and foreign lines skipped. */
function indexedFiles(dir: string): string[] {
	const lines = readFileSync(join(dir, INDEX_FILE), "utf8").split("\n");
	expect(JSON.parse(lines[0] ?? "")).toEqual({ version: 2 });
	const files = new Set<string>();
	for (const line of lines.slice(1)) {
		try {
			const parsed = JSON.parse(line) as { file?: unknown };
			if (typeof parsed.file === "string") files.add(parsed.file);
		} catch {}
	}
	return [...files].sort();
}

describe("session summary index", () => {
	let tempDir: string;
	let projectDir: string;
	let sessionDir: string;

	beforeEach(() => {
		clearSessionSummaryCache();
		tempDir = mkdtempSync(join(tmpdir(), "session-summary-index-"));
		projectDir = join(tempDir, "project");
		sessionDir = join(tempDir, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		writeSession(sessionDir, "alpha", projectDir, ["alpha first", "alpha reply"], "alpha-name");
		writeSession(sessionDir, "beta", projectDir, ["beta first", "beta reply", "beta again"]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		chmodSync(sessionDir, 0o755);
		clearSessionSummaryCache();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** List as a fresh process would: the in-memory cache is empty, only the disk index survives. */
	async function coldList(): Promise<{ rows: SessionInfo[]; streamed: number }> {
		clearSessionSummaryCache();
		const before = sessionSummaryStreamCount();
		const rows = await SessionManager.list(projectDir, sessionDir);
		return { rows, streamed: sessionSummaryStreamCount() - before };
	}

	it("serves unchanged files from the index without streaming them", async () => {
		// Given: a first cold listing that streamed both files and wrote the index.
		const first = await coldList();
		expect(existsSync(join(sessionDir, INDEX_FILE))).toBe(true);
		expect(first.streamed).toBe(2);
		expect(indexedFiles(sessionDir)).toEqual(["alpha.jsonl", "beta.jsonl"]);

		// When: a fresh process lists the unchanged directory.
		const second = await coldList();

		// Then: every row comes from the index and equals the streamed row.
		expect(second.streamed).toBe(0);
		expect(second.rows).toEqual(first.rows);
	});

	it("does not read the index in a warm process for a changed or non-session file", async () => {
		// Given: a warm process whose listing wrote the index, then one session grows and a non-session file appears.
		await coldList();
		writeSession(sessionDir, "beta", projectDir, ["beta first", "beta reply", "beta again", "beta grown"]);
		writeFileSync(join(sessionDir, "notes.jsonl"), `${JSON.stringify({ type: "event", id: "not-a-session" })}\n`);
		const originalParse = JSON.parse;
		let alphaParses = 0;
		vi.spyOn(JSON, "parse").mockImplementation(
			(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown => {
				if (text.includes("alpha first")) alphaParses += 1;
				return originalParse(text, reviver);
			},
		);

		// When: the same process lists again.
		const rows = await SessionManager.list(projectDir, sessionDir);

		// Then: only the changed files are read; the index entry for the unchanged session is never parsed.
		expect(rows.find((row) => row.id === "beta")?.allMessagesText).toContain("beta grown");
		expect(alphaParses).toBe(0);
	});

	it("re-streams a file whose size or mtime changed since it was indexed", async () => {
		// Given: an index written for both files, then one file grows.
		await coldList();
		const beta = join(sessionDir, "beta.jsonl");
		writeSession(sessionDir, "beta", projectDir, ["beta first", "beta reply", "beta again", "beta grown"]);

		// When: a fresh process lists the directory.
		const changed = await coldList();

		// Then: only the changed file is streamed and its new text is served.
		expect(changed.streamed).toBe(1);
		expect(changed.rows.find((row) => row.path === beta)?.allMessagesText).toContain("beta grown");

		// And: the appended entry wins on the next cold listing.
		const next = await coldList();
		expect(next.streamed).toBe(0);
		expect(next.rows).toEqual(changed.rows);
	});

	it("skips a torn trailing index line and re-indexes only that file", async () => {
		// Given: an index whose last line was cut mid-record.
		const first = await coldList();
		const indexPath = join(sessionDir, INDEX_FILE);
		const text = readFileSync(indexPath, "utf8");
		writeFileSync(indexPath, text.slice(0, text.length - 40));

		// When: a fresh process lists the directory.
		const torn = await coldList();

		// Then: one file is re-streamed, rows are unchanged, and the index is whole again.
		expect(torn.streamed).toBe(1);
		expect(torn.rows).toEqual(first.rows);
		expect(indexedFiles(sessionDir)).toEqual(["alpha.jsonl", "beta.jsonl"]);
		expect((await coldList()).streamed).toBe(0);
	});

	it.each([
		["a foreign version header", `${JSON.stringify({ version: 99 })}\n`],
		["non-JSON garbage", "\u0000garbage{{{\nnot json either\n"],
	])("discards an index with %s and rewrites it", async (_label, content) => {
		// Given: a valid listing, then the index replaced by unusable content.
		const first = await coldList();
		writeFileSync(join(sessionDir, INDEX_FILE), content);

		// When: a fresh process lists the directory.
		const recovered = await coldList();

		// Then: every file is streamed, rows are identical, and a valid index replaces it.
		expect(recovered.streamed).toBe(2);
		expect(recovered.rows).toEqual(first.rows);
		expect(indexedFiles(sessionDir)).toEqual(["alpha.jsonl", "beta.jsonl"]);
		expect((await coldList()).streamed).toBe(0);
	});

	it("drops entries for removed session files when it compacts", async () => {
		// Given: an index for three files, two of which are then deleted.
		writeSession(sessionDir, "gamma", projectDir, ["gamma first"]);
		await coldList();
		expect(indexedFiles(sessionDir)).toEqual(["alpha.jsonl", "beta.jsonl", "gamma.jsonl"]);
		rmSync(join(sessionDir, "alpha.jsonl"));
		rmSync(join(sessionDir, "beta.jsonl"));
		writeSession(sessionDir, "gamma", projectDir, ["gamma first", "gamma grown"]);

		// When: a fresh process lists the directory.
		const { rows } = await coldList();

		// Then: the rewritten index holds only the surviving file.
		expect(rows.map((row) => basename(row.path))).toEqual(["gamma.jsonl"]);
		expect(indexedFiles(sessionDir)).toEqual(["gamma.jsonl"]);
	});

	it("returns identical rows when the index cannot be written", async () => {
		// Given: the rows a writable directory produces, then a read-only directory without an index.
		const expected = await coldList();
		rmSync(join(sessionDir, INDEX_FILE));
		chmodSync(sessionDir, 0o555);

		// When: a fresh process lists the read-only directory.
		const readOnly = await coldList();

		// Then: the listing streams and matches, and no index appears.
		expect(readOnly.rows).toEqual(expected.rows);
		expect(readOnly.streamed).toBe(2);
		expect(existsSync(join(sessionDir, INDEX_FILE))).toBe(false);
	});

	it("keeps one index per project directory for listAll with grand-total progress", async () => {
		// Given: two project directories under the quarantined sessions root.
		const root = getSessionsDir();
		const dirs = [join(root, `--index-a-${basename(tempDir)}--`), join(root, `--index-b-${basename(tempDir)}--`)];
		for (const [i, dir] of dirs.entries()) {
			mkdirSync(dir, { recursive: true });
			writeSession(dir, `all-${i}-one`, projectDir, [`all ${i} one`]);
			writeSession(dir, `all-${i}-two`, projectDir, [`all ${i} two`]);
		}
		try {
			const progress: Array<[number, number]> = [];
			clearSessionSummaryCache();

			// When: every project directory is listed.
			const rows = await SessionManager.listAll((loaded, total) => progress.push([loaded, total]));

			// Then: each directory got its own index, and progress counted to the grand total.
			const total = progress.at(-1)?.[1] ?? 0;
			expect(total).toBeGreaterThanOrEqual(4);
			expect(progress.map(([loaded]) => loaded)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
			expect(rows.filter((row) => row.id.startsWith("all-"))).toHaveLength(4);
			expect(indexedFiles(dirs[0] ?? "")).toEqual(["all-0-one.jsonl", "all-0-two.jsonl"]);
			expect(indexedFiles(dirs[1] ?? "")).toEqual(["all-1-one.jsonl", "all-1-two.jsonl"]);
		} finally {
			for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		}
	});
});
