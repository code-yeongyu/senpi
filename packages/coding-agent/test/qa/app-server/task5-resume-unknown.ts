import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThreadNotFoundError, ThreadRegistry } from "../../../src/modes/app-server/threads/registry.ts";

const scratchRoot = join(tmpdir(), `senpi-qa-task5-${process.pid}`);

async function main(): Promise<void> {
	rmSync(scratchRoot, { recursive: true, force: true });
	let runError: unknown;
	try {
		const registry = new ThreadRegistry({
			agentDir: join(scratchRoot, "agent"),
			sessionDir: join(scratchRoot, "sessions"),
		});
		try {
			await registry.resumeThread("00000000-0000-0000-0000-000000000000");
			throw new Error("resumeThread unexpectedly succeeded");
		} catch (error) {
			if (!(error instanceof ThreadNotFoundError)) {
				throw error;
			}
			console.log(`${error.name}: ${error.message}`);
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
