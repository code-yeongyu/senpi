import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionRow } from "../../src/modes/rpc/host-session-ref.ts";

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hs-ref-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// #3073: a reference resolves anew on every call, so durable ids and paths survive a new routing handle.
describe("host session reference resolution", () => {
	it("resolves routing ids before durable ids, names and canonical paths", async () => {
		const dir = scratch();
		const path = join(dir, "session.jsonl");
		writeFileSync(path, "");
		const alias = join(dir, "alias.jsonl");
		symlinkSync(path, alias);
		const row = {
			sessionId: "rpc-1",
			durableSessionId: "durable",
			name: "lane",
			sessionPath: path,
			cwd: dir,
			status: "open" as const,
		};
		const client = { listSessions: async () => [row] };
		for (const ref of ["rpc-1", "durable", "lane", path, alias])
			expect(await resolveSessionRow(client, ref)).toBe(row);
		expect(await resolveSessionRow(client, "missing")).toBeUndefined();
	});
});
