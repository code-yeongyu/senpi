import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";

/**
 * Regression: a startup failure must surface its own cause.
 *
 * `startHost()` terminates the spawned child when registration fails before the
 * pidfile is written. That cleanup kill sets the same `exitedEarly` record the
 * child's own exit would, so the catch block mistook its own SIGTERM for the
 * host dying unprompted, dropped the real error, and reported "exited with code
 * null (SIGTERM) before answering get_protocol_info". On the windows-latest
 * runner that made every genuine startup failure unobservable and was reported
 * as the flake in code-yeongyu/senpi#1290.
 */

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(label: string): Promise<{ root: string; agentDir: string; socket: string }> {
	const root = await mkdtemp(join(tmpdir(), `senpi-host-ensure-${label}-`));
	roots.push(root);
	return { root, agentDir: join(root, "agent"), socket: join(root, "rpc.sock") };
}

const STARTUP_FAILURE = "disk full while registering the host";

describe("startHost startup-failure diagnostics", () => {
	it("surfaces the original startup error instead of its own cleanup signal", async () => {
		const qa = await scratch("startup-error");
		const fixture = join(import.meta.dirname, "..", "..", "fixtures", "rpc-host-fixture.mjs");

		const failure = await ensureHost({
			agentDir: qa.agentDir,
			socket: qa.socket,
			_test: {
				spawn: {
					command: process.execPath,
					args: [fixture, qa.socket, VERSION, "multi_session,extension_events", "answer"],
				},
				// The child is healthy; only registration fails. This is the shape a
				// loaded runner produces when the identity probe or pidfile write dies.
				beforePidFileWrite: async () => {
					throw new Error(STARTUP_FAILURE);
				},
			},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;

		// The real cause must reach the caller.
		expect(message).toContain(STARTUP_FAILURE);
		// And must NOT be replaced by the signal this code path sent itself.
		expect(message).not.toContain("before answering get_protocol_info");
	}, 30_000);
});
