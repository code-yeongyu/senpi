/**
 * senpi#3305: a handoff rewrites its successor's generation record once the successor answers, and
 * `host status` reads that record without a lock. The rewrite truncated the file in place, so a read
 * between the truncate and the write - or any read after a writer that ended there - found no record:
 * the generation serving the socket was missing from the report, and a caller waiting for its row
 * (`rpc-host-handoff-clientless.test.ts`) asked the successor again and was refused `stale_generation`.
 *
 * Storage contract under test: a record is REPLACED, never written through. A hard link to the record
 * stands in for a reader that holds it while the rewrite runs: a rewrite in place changes what that
 * reader holds (and empties it first), a replacement leaves it the complete previous record.
 */
import { link, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeGenerationRecord, writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { readGenerationRows } from "../../../src/modes/rpc/host-generations.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("rewriting a running generation's record (senpi#3305)", () => {
	it("replaces the record, so a reader holding the previous one never sees it emptied or changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-3305-"));
		roots.push(root);
		const socket = join(root, "rpc.sock");
		const paths = createHostDaemonPaths({ socket, agentDir: root });
		const spawned = {
			record: { pid: process.pid, processStartTime: null },
			socket,
			instanceId: "successor",
			generation: 2,
			launchProfileId: "profile",
		};
		await writeGenerationRecord(paths, spawned);
		const heldByReader = join(root, "held-by-reader");
		await link(generationPaths(paths, "successor").pidFile, heldByReader);
		const previous = await readFile(heldByReader, "utf8");

		await writeHostRegistration(paths, { ...spawned, build: { text: "2026.11.26", ordinal: [2026, 11, 26, 0, 0] } });

		expect(await readFile(heldByReader, "utf8")).toBe(previous);
		const rows = await readGenerationRows(paths);
		expect(rows.map((row) => [row.instanceId, row.generation, row.engineVersion, row.current, row.alive])).toEqual([
			["successor", 2, "2026.11.26", true, true],
		]);
	});
});
