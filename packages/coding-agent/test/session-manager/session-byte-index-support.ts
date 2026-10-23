import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { IndexedEntry } from "../../src/core/session-index/index-record.ts";
import type { SessionByteIndex } from "../../src/core/session-index/session-byte-index.ts";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function sessionDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-byte-index-")));
	dirs.push(dir);
	return dir;
}

export const header = { type: "session", version: 3, id: "s-1", timestamp: "2026-10-23T00:00:00.000Z", cwd: "/repo" };

export function user(id: string, parentId: string | null, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-23T00:00:01.000Z",
		message: { role: "user", content: text, timestamp: 1 },
	};
}

export function assistant(id: string, parentId: string, text: string): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-10-23T00:00:02.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, cost: { total: 0.25 } },
			timestamp: 2,
		},
	};
}

export function recordAt(index: SessionByteIndex, position: number): IndexedEntry {
	const record = index.records[position];
	if (record === undefined) throw new Error(`no index record at ${position}`);
	return record;
}

export const jsonl = (entries: readonly unknown[]): string =>
	entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");

export function writeSessionFile(dir: string, entries: readonly unknown[], name = "session.jsonl"): string {
	const file = join(dir, name);
	writeFileSync(file, jsonl(entries));
	return file;
}
