import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadRegistry } from "../../../src/modes/app-server/threads/registry.ts";

const scratchRoot = join(tmpdir(), `senpi-qa-task5-${process.pid}`);

async function main(): Promise<void> {
	rmSync(scratchRoot, { recursive: true, force: true });
	let runError: unknown;
	try {
		const registry = new ThreadRegistry({
			agentDir: join(scratchRoot, "agent"),
			sessionDir: join(scratchRoot, "sessions"),
		});
		const created = await registry.createThread({ cwd: tmpdir() });
		const forked = await registry.forkThread(created.id);
		const loaded = registry.listLoaded();
		console.log(`THREADS=${loaded.length} FORK_DIFFERS=${forked.id !== created.id}`);
		if (loaded.length !== 2 || forked.id === created.id) {
			throw new Error("registry fork scenario failed");
		}
	} catch (error) {
		runError = error;
	}
	rmSync(scratchRoot, { recursive: true, force: true });
	if (existsSync(scratchRoot)) {
		throw new Error(`cleanup failed: ${scratchRoot}`);
	}
	if (runError) {
		throw runError;
	}
}

await main();
