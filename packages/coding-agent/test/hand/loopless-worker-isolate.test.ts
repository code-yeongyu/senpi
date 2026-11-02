// senpi#5413 (Z2, brain/hand split): a loopless worker runs in its own session-worker isolate. It starts with the
// built-in tools, runs no agent loop, writes no session file and exits when closed.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { LooplessWorkerPool } from "../../src/modes/rpc/loopless-worker-pool.ts";
import { WorkerCapacity } from "../../src/modes/rpc/worker-capacity.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("loopless worker isolate (senpi#5413)", () => {
	it("starts with the built-in tools, writes no session file and exits on close", async () => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-rt10-isolate-"));
		cleanups.push(() => rm(scratch, { recursive: true, force: true }));
		const cwd = join(scratch, "project");
		const agentDir = join(scratch, "agent");
		await mkdir(cwd, { recursive: true });
		const pool = new LooplessWorkerPool({
			configuration: {
				parsed: parseArgs(["--mode", "rpc", "--no-skills", "--no-context-files", "--no-prompt-templates"]),
				cwd,
				agentDir,
				appMode: "rpc",
			},
			capacity: new WorkerCapacity(),
		});

		const opened = await pool.open(cwd);
		await pool.close(opened.id);

		expect(opened.tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write"]));
		expect(pool.size).toBe(0);
		const files = await readdir(scratch, { recursive: true });
		expect(files.filter((name) => String(name).endsWith(".jsonl"))).toEqual([]);
	}, 120_000);
});
