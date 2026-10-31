import { spawnSync } from "node:child_process";
import { closeSync, fstatSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ADOPTABLE_MAX } from "../../src/private-fds.ts";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";
import { attachStartupEvents, newStartupAttempt } from "../../src/modes/rpc/host-startup-events.ts";
import { type StartupClock, startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import {
	encodeStartupHandOff,
	parseStartupHandOff,
	releaseInheritedStartupFillers,
	relayStartupLine,
	STARTUP_EVENT_FD,
	type StartupBinding,
	startupEventLine,
	withStartupPipe,
} from "../../src/modes/rpc/host-startup-wire.ts";

const fillerFixture = join(import.meta.dirname, "..", "fixtures", "startup-pipe-filler-spawn.ts");
const frozenClock: StartupClock = { now: () => 0, scheduleAt: () => undefined, cancel: () => {} };

function binding(): StartupBinding {
	return {
		attempt: newStartupAttempt(),
		endpoint: "/tmp/senpi-test/host.sock",
		instanceId: "instance-1",
		generation: 0,
		launchKind: "initial",
		predecessor: null,
	};
}

describe("startup event wire (senpi#4602)", () => {
	it("keeps the startup pipe outside the private descriptor table's forwarded range", () => {
		expect(STARTUP_EVENT_FD).toBeGreaterThan(ADOPTABLE_MAX);
	});

	it("fills only the unused slots below the startup pipe, so libuv never sees a hole under it", () => {
		const { stdio, fillers } = withStartupPipe(["ignore", "ignore", 7, "pipe", "ignore"] as const);
		expect(stdio).toHaveLength(STARTUP_EVENT_FD + 1);
		expect(stdio[STARTUP_EVENT_FD]).toBe("pipe");
		expect(stdio.slice(0, 4)).toEqual(["ignore", "ignore", 7, "pipe"]);
		expect(fillers).toEqual(Array.from({ length: STARTUP_EVENT_FD - 4 }, (_, index) => index + 4));
		expect(stdio.slice(4, STARTUP_EVENT_FD).every((slot) => slot === "pipe")).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"leaves exactly stdio, the private descriptor and the startup pipe open in the child, and only the intended ends in the parent",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "senpi-startup-filler-"));
			try {
				const run = spawnSync(process.execPath, [fillerFixture, join(dir, "private.txt")], {
					encoding: "utf8",
					env: hostSpawnEnv(),
					timeout: 60_000,
				});
				expect(run.status, run.stderr).toBe(0);
				const report = JSON.parse(run.stdout.trim());
				expect(report).toMatchObject({ code: 0, privateWrote: "private-ok" });
				expect(report.startup).toContain('"milestone":"supervisor_bootstrap"');
				// The private descriptor kept its own number; every other slot below the pipe was a filler.
				expect(report.privateSlot).toBe(report.privateFd);
				expect(report.fillers.length).toBeGreaterThan(0);
				// Child: in the slots the spawn controls, exactly stdio, the private descriptor and the pipe.
				const controlled = report.child.filter((fd: number) => fd <= STARTUP_EVENT_FD);
				expect(controlled).toEqual([0, 1, 2, report.privateFd, STARTUP_EVENT_FD].sort((a, b) => a - b));
				// Above them only the Node runtime's own descriptors: as many as a bare child of the same script holds.
				const runtime = report.child.filter((fd: number) => fd > STARTUP_EVENT_FD);
				expect(runtime).toHaveLength(report.control.filter((fd: number) => fd > 2).length);
				// Parent: the pre-spawn set plus only the stdout and startup pipe ends; no filler end survives, and the
				// private descriptor's ownership moved to the child (#4749's transfer closes the parent's copy).
				expect(report.intendedParentEnds.every((fd: unknown) => typeof fd === "number")).toBe(true);
				const kept = report.before.filter((fd: number) => fd !== report.privateFd);
				expect(report.after).toEqual([...kept, ...report.intendedParentEnds].sort((a, b) => a - b));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		60_000,
	);

	it("round-trips a hand-off and refuses a malformed one", () => {
		const handOff = { binding: binding(), role: "host" as const, budgetMs: 180_000, fillers: [3, 5] };
		expect(parseStartupHandOff(encodeStartupHandOff(handOff))).toEqual(handOff);
		expect(parseStartupHandOff("{")).toBeUndefined();
		expect(parseStartupHandOff(JSON.stringify({ ...handOff, role: "launcher" }))).toBeUndefined();
		expect(parseStartupHandOff(JSON.stringify({ ...handOff, budgetMs: 0 }))).toBeUndefined();
	});

	it.skipIf(process.platform === "win32")(
		"releases the inherited fillers, keeps a slot the private table names, and strips the list",
		() => {
			const [filler, privateSlot] = [openSync("/dev/null", "r"), openSync("/dev/null", "r")];
			const env: NodeJS.ProcessEnv = {
				SENPI_PRIVATE_FDS: JSON.stringify({ channel: privateSlot }),
				SENPI_RPC_HOST_STARTUP_EVENTS: encodeStartupHandOff({
					binding: binding(),
					role: "supervisor",
					budgetMs: 180_000,
					fillers: [filler, privateSlot].filter((fd) => fd >= 3 && fd < STARTUP_EVENT_FD),
				}),
			};
			try {
				releaseInheritedStartupFillers(env);
				if (filler < STARTUP_EVENT_FD) expect(() => fstatSync(filler)).toThrow();
				expect(() => fstatSync(privateSlot)).not.toThrow();
				expect(parseStartupHandOff(env.SENPI_RPC_HOST_STARTUP_EVENTS)?.fillers).toEqual([]);
			} finally {
				for (const fd of [filler, privateSlot]) {
					try {
						closeSync(fd);
					} catch {
						// Released above: already closed.
					}
				}
			}
		},
	);

	it("feeds relayed host records to the host ingress and the supervisor's own to the supervisor ingress", () => {
		const attempt = binding();
		const controller = startStartupController({ launchKind: "initial", clock: frozenClock });
		const pipe = new PassThrough();
		attachStartupEvents(pipe, controller, attempt);
		pipe.write(startupEventLine(attempt, "supervisor", 1, "supervisor_bootstrap"));
		pipe.write(startupEventLine(attempt, "supervisor", 2, "supervisor_setup"));
		pipe.write(relayStartupLine(startupEventLine(attempt, "host", 1, "host_bootstrap").trimEnd()));
		pipe.write(relayStartupLine(startupEventLine(attempt, "host", 2, "host_runtime").trimEnd()).slice(0, 20));
		expect(controller.phase).toBe("host_runtime");
		pipe.write(relayStartupLine(startupEventLine(attempt, "host", 2, "host_runtime").trimEnd()).slice(20));
		expect(controller.phase).toBe("internal_ready");
		expect(controller.terminal).toBeUndefined();
	});

	it("fails the attempt when the supervisor reports a host milestone without a relay frame", () => {
		const attempt = binding();
		const controller = startStartupController({ launchKind: "initial", clock: frozenClock });
		const pipe = new PassThrough();
		attachStartupEvents(pipe, controller, attempt);
		pipe.write(startupEventLine(attempt, "supervisor", 1, "supervisor_bootstrap"));
		pipe.write(startupEventLine(attempt, "supervisor", 2, "supervisor_setup"));
		pipe.write(startupEventLine(attempt, "host", 1, "host_bootstrap"));
		expect(controller.terminal).toMatchObject({ kind: "failed", phase: "host_bootstrap" });
	});
});
