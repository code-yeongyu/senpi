import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ADOPTABLE_MAX } from "../../src/private-fds.ts";
import { attachStartupEvents, newStartupAttempt } from "../../src/modes/rpc/host-startup-events.ts";
import { type StartupClock, startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import {
	encodeStartupHandOff,
	parseStartupHandOff,
	relayStartupLine,
	STARTUP_EVENT_FD,
	type StartupBinding,
	startupEventLine,
	startupEventStdio,
	unwrapStartupRelay,
} from "../../src/modes/rpc/host-startup-wire.ts";

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

	it("leaves every slot before the startup pipe closed and puts the pipe at its descriptor", () => {
		const stdio = ["ignore", "ignore", "inherit", "pipe", ...startupEventStdio(4)];
		expect(stdio).toHaveLength(STARTUP_EVENT_FD + 1);
		expect(stdio[STARTUP_EVENT_FD]).toBe("pipe");
		expect(stdio.slice(4, STARTUP_EVENT_FD).every((slot) => slot === "ignore")).toBe(true);
	});

	it("round-trips a hand-off and refuses a malformed one", () => {
		const handOff = { binding: binding(), role: "host" as const, budgetMs: 180_000 };
		expect(parseStartupHandOff(encodeStartupHandOff(handOff))).toEqual(handOff);
		expect(parseStartupHandOff("{")).toBeUndefined();
		expect(parseStartupHandOff(JSON.stringify({ ...handOff, role: "launcher" }))).toBeUndefined();
		expect(parseStartupHandOff(JSON.stringify({ ...handOff, budgetMs: 0 }))).toBeUndefined();
	});

	it("frames a relayed host record so it cannot be read as the supervisor's own", () => {
		const line = startupEventLine(binding(), "host", 1, "host_bootstrap").trimEnd();
		expect(unwrapStartupRelay(relayStartupLine(line).trimEnd())).toBe(line);
		expect(unwrapStartupRelay(line)).toBeUndefined();
	});

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
