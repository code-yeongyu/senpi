// senpi#7141's contract for the socket worker-host fixture: a host that exits before it listens fails the wait at once
// with its exit and stderr, instead of holding the test for a fixed listener budget that ignores the exit.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { startInProcessHost } from "../rpc-worker-host-support.ts";

const scratch: string[] = [];

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("rejects with the host's exit and stderr when the socket host dies before listening", async () => {
	// Given: a host binary that reports a boot failure and exits
	const dir = await mkdtemp(join(tmpdir(), "worker-host-boot-exit-"));
	scratch.push(dir);
	const host = join(dir, "host");
	await writeFile(host, "#!/bin/sh\necho 'boot failed: synthetic' >&2\nexit 3\n");
	await chmod(host, 0o755);
	vi.stubEnv("SENPI_RPC_TEST_BINARY", host);

	// When / Then: the readiness wait settles on that exit, not on a timer
	await expect(startInProcessHost()).rejects.toThrow(/^Host exited \(3\) before listening: .*boot failed: synthetic/s);
});
