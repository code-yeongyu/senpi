import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSessionRef } from "../../src/modes/rpc/host-session-ref.ts";

const dirs: string[] = [];
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hs-ref-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// #3073: a reference resolves anew on every call against the host's live listing (parks: host-session-park.test.ts).
describe("host session reference resolution", () => {
	it("resolves a live row by routing id, durable id, name or canonical path", async () => {
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
			expect(await resolveSessionRef(client, ref, dir)).toEqual({ kind: "live", row });
		expect(await resolveSessionRef(client, "missing", dir)).toEqual({ kind: "unknown" });
	});

	// senpi#6973 L1: the CLI's durable-id lookup is find_session's (one walk, one bound), so it finds what find_session finds.
	it("#given a parked session file directly in <agentDir>/sessions #when the reference is its durable id #then it resolves to that file, as find_session does", async () => {
		const agentDir = scratch();
		const sessions = join(agentDir, "sessions");
		mkdirSync(sessions, { recursive: true });
		const id = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e5";
		const path = join(sessions, `2026-11-11T00-00-00-000Z_${id}.jsonl`);
		writeFileSync(
			path,
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-11T00:00:00.000Z", cwd: sessions })}\n`,
		);

		expect(await resolveSessionRef({ listSessions: async () => [] }, id, agentDir)).toEqual({
			kind: "parked",
			sessionPath: path,
			cwd: sessions,
			durableSessionId: id,
		});
	});

	it("#given two session files that carry one durable id #when the reference is that id #then it is ambiguous, naming both", async () => {
		const agentDir = scratch();
		const id = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e5";
		const files = ["--a--", "--b--"].map((folder) => {
			const dir = join(agentDir, "sessions", folder);
			mkdirSync(dir, { recursive: true });
			const file = join(dir, `2026-11-11T00-00-00-000Z_${id}.jsonl`);
			writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id, cwd: dir })}\n`);
			return file;
		});

		const answer = await resolveSessionRef({ listSessions: async () => [] }, id, agentDir);

		expect(answer.kind).toBe("ambiguous");
		expect(answer.kind === "ambiguous" ? [...answer.candidates].sort() : []).toEqual([...files].sort());
	});
});
