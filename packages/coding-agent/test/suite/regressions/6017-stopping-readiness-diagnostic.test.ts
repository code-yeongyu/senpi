import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../../../src/config.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { reapProcessesUnder } from "../../helpers/spawned-host-reaper.ts";

/**
 * Regression (senpi#6017): a host that answers its readiness probe with `lifecycle: "stopping"` is
 * stopping, not incompatible.
 *
 * A supervisor that began its shutdown before the ensure that started it verified it answers from its
 * own admission: `capabilities: []` plus the `socket_auth` the public filter adds. `startHost` formatted
 * that reply as an incompatible protocol, which sent readers after a version mismatch that did not exist.
 * The fixture answers once and then exits, as that supervisor does, so the exit (not the readiness
 * budget) ends the wait and the reply is the last one the gate saw.
 */

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await reapProcessesUnder(root);
		await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
	}
}, 60_000);

async function ensureAnsweringOnce(label: string, lifecycle: "ready" | "stopping"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `senpi-host-ensure-${label}-`));
	roots.push(root);
	const socket = join(root, "rpc.sock");
	const fixture = join(import.meta.dirname, "..", "..", "fixtures", "rpc-host-fixture.mjs");
	const failure = await ensureHost({
		agentDir: join(root, "agent"),
		socket,
		_test: {
			// Far beyond the test budget: settling at all proves the fixture's exit ended the wait.
			readinessTimeoutMs: 600_000,
			spawn: {
				command: process.execPath,
				args: [fixture, socket, VERSION, "socket_auth", "exit-after-answer", JSON.stringify({ lifecycle })],
			},
		},
	}).then(
		() => new Error("ensureHost accepted a host that cannot admit a session"),
		(error: unknown) => error,
	);
	expect(failure).toBeInstanceOf(Error);
	return (failure as Error).message;
}

describe("startHost readiness reply diagnostics (senpi#6017)", () => {
	it("reports a stopping reply as a stop during startup, with the exit that followed it", async () => {
		const message = await ensureAnsweringOnce("stopping-reply", "stopping");

		expect(message).toContain('lifecycle "stopping"');
		expect(message).toContain("exited with code 0");
		expect(message).not.toContain("incompatible");
	}, 30_000);

	it("keeps the incompatible diagnostic for a ready host that lacks the required capabilities", async () => {
		const message = await ensureAnsweringOnce("mismatch-reply", "ready");

		expect(message).toContain('capabilities ["socket_auth"]');
		expect(message).toContain("incompatible with protocol version");
	}, 30_000);
});
