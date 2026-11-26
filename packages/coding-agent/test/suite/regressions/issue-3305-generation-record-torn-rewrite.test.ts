/**
 * senpi#3305: a handoff rewrites its successor's generation record once the successor answers, and
 * `host status` reads that record without a lock. The rewrite truncated the file in place, so a read
 * between the truncate and the write - or any read after a writer that ended there - found no record:
 * the generation serving the socket was missing from the report, and a caller waiting for its row
 * (`rpc-host-handoff-clientless.test.ts`) asked the successor again and was refused `stale_generation`.
 *
 * The fault is injected at the file system: the write under way truncates its target and then fails,
 * which is what a reader observes when the writer is cut off after the truncate.
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { writeGenerationRecord, writeHostRegistration } from "../../../src/modes/rpc/host-daemon-registration.ts";
import { readGenerationRows } from "../../../src/modes/rpc/host-generations.ts";

const fault = vi.hoisted(() => ({ cutWritesShort: false }));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const writeFile: typeof actual.writeFile = async (file, data, options) => {
		if (!fault.cutWritesShort || typeof file !== "string") return actual.writeFile(file, data, options);
		await (await actual.open(file, "w")).close();
		throw new Error("the writer was cut off after truncating its target");
	};
	return { ...actual, default: { ...actual, writeFile }, writeFile };
});

const roots: string[] = [];

afterEach(async () => {
	fault.cutWritesShort = false;
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("a generation record rewrite that is cut short (senpi#3305)", () => {
	it("leaves the running generation in the rows `host status` reports", async () => {
		const root = await mkdtemp(join(tmpdir(), "senpi-3305-"));
		roots.push(root);
		const socket = join(root, "rpc.sock");
		const paths = createHostDaemonPaths({ socket, agentDir: root });
		const registration = {
			record: { pid: process.pid, processStartTime: null },
			socket,
			instanceId: "successor",
			generation: 2,
			launchProfileId: "profile",
		};
		await writeGenerationRecord(paths, registration);

		fault.cutWritesShort = true;
		await expect(writeHostRegistration(paths, registration)).rejects.toThrow();
		fault.cutWritesShort = false;

		const rows = await readGenerationRows(paths);
		expect(rows.map((row) => ({ instanceId: row.instanceId, generation: row.generation, alive: row.alive }))).toEqual(
			[{ instanceId: "successor", generation: 2, alive: true }],
		);
		const left = await readdir(generationPaths(paths, "successor").dir);
		expect(left.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});
