import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const header = { type: "session", version: 3, id: "source-id", timestamp: "2026-10-16T17:51:18.778Z", cwd: "/work" };
const message = (id: string, parentId: string | null) => ({
	type: "message",
	id,
	parentId,
	timestamp: "2026-10-16T22:44:22.972Z",
	message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 },
});
const jsonl = (...rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function source(content: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-fork-headerless-"));
	const path = join(dir, "source.jsonl");
	writeFileSync(path, content);
	return { dir, path };
}

function sessionFileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (file === undefined) throw new Error("the fork wrote no session file");
	return file;
}

const forkedEntryIds = (file: string): string[] =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type: string; id: string })
		.filter((entry) => entry.type !== "session")
		.map((entry) => entry.id);

describe("SessionManager.forkFrom with a source whose header line is missing (omo#10375)", () => {
	it("forks every entry of a session file that lost its line-1 header", () => {
		const { dir, path } = source(jsonl(message("m2", "m1"), message("m3", "m2")));

		const forked = SessionManager.forkFrom(path, dir, dir);

		expect(forked.getHeader()?.parentSession).toBe(path);
		expect(forkedEntryIds(sessionFileOf(forked))).toEqual(["m2", "m3"]);
	});

	it("still forks a source that has its header", () => {
		const { dir, path } = source(jsonl(header, message("m1", null)));

		const forked = SessionManager.forkFrom(path, dir, dir);

		expect(forkedEntryIds(sessionFileOf(forked))).toEqual(["m1"]);
	});

	it("calls an empty file empty", () => {
		const { dir, path } = source("");

		expect(() => SessionManager.forkFrom(path, dir, dir)).toThrow(/source session file is empty/);
	});

	it("says a file with entries but no session shape is not a session, and not that it is empty", () => {
		const { dir, path } = source(jsonl({ hello: "world" }, { not: "a session" }));

		expect(() => SessionManager.forkFrom(path, dir, dir)).toThrow(/not a session file/);
	});
});
