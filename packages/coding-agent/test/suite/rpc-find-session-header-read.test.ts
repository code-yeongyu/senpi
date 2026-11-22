/**
 * senpi#6553: `find_session` reads the first line of every candidate. A header is a few hundred bytes, so a long session
 * file must not cost its full 64 KiB header limit on every lookup.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => [] as number[]);

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			const read = handle.read.bind(handle) as (...readArgs: unknown[]) => Promise<{ bytesRead: number }>;
			handle.read = (async (...readArgs: unknown[]) => {
				const result = await read(...readArgs);
				reads.push(result.bytesRead);
				return result;
			}) as typeof handle.read;
			return handle;
		},
	};
});

const { findSession } = await import("../../src/modes/rpc/find-session.ts");

const ID = "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9e5";
const roots: string[] = [];

afterEach(async () => {
	reads.length = 0;
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function agentDir(): Promise<{ agent: string; folder: string }> {
	const agent = await mkdtemp(join(tmpdir(), "find-session-header-"));
	roots.push(agent);
	const folder = join(agent, "sessions", "--work--");
	mkdirSync(folder, { recursive: true });
	return { agent, folder };
}

describe("find_session reads only the header it needs (senpi#6553)", () => {
	it("#given a long session file whose header fits in the first chunk #then the lookup reads no more than that chunk", async () => {
		const { agent, folder } = await agentDir();
		const file = join(folder, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
		writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: ID, cwd: folder })}\n${"x".repeat(70 * 1024)}\n`);

		const answer = await findSession({ agentDir: agent, hosted: () => [] }, { id: "fs", durableSessionId: ID });

		expect(answer).toMatchObject({ success: true, data: { found: { sessionPath: file, cwd: folder, open: false } } });
		expect(reads).toEqual([4 * 1024]);
	});

	it("#given a header longer than the first chunk but within the limit #then it is still found", async () => {
		const { agent, folder } = await agentDir();
		const file = join(folder, `2026-11-11T00-00-00-000Z_${ID}.jsonl`);
		const header = { type: "session", version: 3, id: ID, cwd: folder, padding: "p".repeat(8 * 1024) };
		writeFileSync(file, `${JSON.stringify(header)}\n${"x".repeat(70 * 1024)}\n`);

		const answer = await findSession({ agentDir: agent, hosted: () => [] }, { id: "fs", durableSessionId: ID });

		expect(answer).toMatchObject({ success: true, data: { found: { sessionPath: file, cwd: folder, open: false } } });
		expect(reads.reduce((sum, bytes) => sum + bytes, 0)).toBe(64 * 1024);
	});
});
