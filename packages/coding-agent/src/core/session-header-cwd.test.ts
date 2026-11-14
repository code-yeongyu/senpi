/**
 * `readHeaderCwd`'s own contract (senpi#6427): what it answers for a file that is not there, one that names no
 * folder, one whose header lies past the bounded scan, and one that cannot be opened at all. The last is the
 * load-bearing one: a path the engine cannot read must not be answered as "no file yet", because the open would then
 * work in the host's folder, which is the defect this path exists to close.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readHeaderCwd } from "./session-header-cwd.ts";

const root = mkdtempSync(join(tmpdir(), "senpi-header-cwd-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const header = (cwd?: string) =>
	`${JSON.stringify({ type: "session", id: "session-1", ...(cwd === undefined ? {} : { cwd }) })}\n`;

function sessionFile(name: string, body: string): string {
	const file = join(root, name);
	writeFileSync(file, body);
	return file;
}

describe("readHeaderCwd", () => {
	it("#given a file whose header names a folder #then it answers that folder", async () => {
		await expect(readHeaderCwd(sessionFile("named.jsonl", header("/work/project")))).resolves.toBe("/work/project");
	});

	it("#given a file whose header names no folder #then it answers undefined", async () => {
		await expect(readHeaderCwd(sessionFile("unnamed.jsonl", header()))).resolves.toBeUndefined();
	});

	it("#given no file at the path, and a path under a file #then both answer undefined, so the open creates the session", async () => {
		const file = sessionFile("a-file.jsonl", header("/work/project"));
		await expect(readHeaderCwd(join(root, "not-there.jsonl"))).resolves.toBeUndefined();
		await expect(readHeaderCwd(join(file, "under-a-file.jsonl"))).resolves.toBeUndefined();
	});

	it("#given a header past the bounded scan #then the whole file is read and that folder answered", async () => {
		const long = `${"x".repeat(1024 * 1024 + 64)}\n${header("/work/late-header")}`;
		await expect(readHeaderCwd(sessionFile("late-header.jsonl", long))).resolves.toBe("/work/late-header");
	});

	it("#given a path that cannot be opened at all #then it throws instead of answering undefined", async () => {
		const loop = join(root, "loop-a.jsonl");
		const back = join(root, "loop-b.jsonl");
		symlinkSync(back, loop);
		symlinkSync(loop, back);

		await expect(readHeaderCwd(loop)).rejects.toThrow(/ELOOP|too many/i);
	});
});
