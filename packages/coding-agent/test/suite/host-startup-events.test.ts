/**
 * senpi#4602: startup-event records feed the startup controller only from the producer bound to
 * that phase, for the attempt the controller allocated, in strict per-producer sequence.
 */
import { describe, expect, it } from "vitest";
import { newStartupAttempt, startupEventIngress } from "../../src/modes/rpc/host-startup-events.ts";
import {
	MAX_STARTUP_EVENT_BYTES,
	type StartupBinding,
	startupEventLine,
} from "../../src/modes/rpc/host-startup-wire.ts";
import { type StartupClock, startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";

const frozenClock: StartupClock = { now: () => 0, scheduleAt: () => undefined, cancel: () => {} };

function attempt() {
	const binding: StartupBinding = {
		attempt: newStartupAttempt(),
		endpoint: "/tmp/senpi-test/host.sock",
		instanceId: "instance-1",
		generation: 0,
		launchKind: "initial",
		predecessor: null,
	};
	const controller = startStartupController({ launchKind: "initial", clock: frozenClock });
	return {
		binding,
		controller,
		supervisor: startupEventIngress(controller, binding, "supervisor"),
		host: startupEventIngress(controller, binding, "host"),
	};
}

describe("startup event ingress (senpi#4602)", () => {
	it("advances the controller only through each phase's own producer", () => {
		const { binding, controller, supervisor, host } = attempt();
		expect(supervisor(startupEventLine(binding, "supervisor", 1, "supervisor_bootstrap"))).toBe("accepted");
		expect(supervisor(startupEventLine(binding, "supervisor", 2, "supervisor_setup"))).toBe("accepted");
		expect(host(startupEventLine(binding, "host", 1, "host_bootstrap"))).toBe("accepted");
		expect(host(startupEventLine(binding, "host", 2, "host_runtime"))).toBe("accepted");
		expect(supervisor(startupEventLine(binding, "supervisor", 3, "internal_ready"))).toBe("accepted");
		expect(controller.terminal).toBeUndefined();
	});

	it("discards another attempt's records without advancing or failing", () => {
		const { binding, controller, supervisor } = attempt();
		const stale = { ...binding, attempt: newStartupAttempt() };
		expect(supervisor(startupEventLine(stale, "supervisor", 1, "supervisor_bootstrap"))).toBe("discarded");
		expect(supervisor(startupEventLine(binding, "supervisor", 1, "supervisor_bootstrap"))).toBe("accepted");
		expect(controller.terminal).toBeUndefined();
	});

	it("ignores a duplicate sequence number", () => {
		const { binding, supervisor } = attempt();
		const line = startupEventLine(binding, "supervisor", 1, "supervisor_bootstrap");
		expect(supervisor(line)).toBe("accepted");
		expect(supervisor(line)).toBe("ignored");
	});

	it.each([
		["a sequence gap", "supervisor", 2, "supervisor_bootstrap"],
		["a role claimed on another producer's stream", "host", 1, "supervisor_bootstrap"],
		["a phase another role owns", "supervisor", 1, "host_bootstrap"],
		["a phase only the controller completes", "supervisor", 1, "public_verified"],
		["an unknown milestone", "supervisor", 1, "warming_up"],
	] as const)("fails the attempt on %s", (_case, role, seq, milestone) => {
		const { binding, controller, supervisor } = attempt();
		const line = `${JSON.stringify({ v: 1, binding, role, seq, milestone })}\n`;
		expect(supervisor(line)).toBe("protocol_failure");
		expect(controller.terminal).toMatchObject({ kind: "failed" });
	});

	it("fails the attempt on a malformed or oversized record", () => {
		const malformed = attempt();
		expect(malformed.supervisor("not json\n")).toBe("protocol_failure");
		const oversized = attempt();
		expect(oversized.supervisor(`${"x".repeat(MAX_STARTUP_EVENT_BYTES + 1)}\n`)).toBe("protocol_failure");
		expect(oversized.controller.terminal).toMatchObject({ kind: "failed" });
	});

	it("fails a producer milestone sent before its phase was granted", () => {
		const { binding, controller, supervisor } = attempt();
		expect(supervisor(startupEventLine(binding, "supervisor", 1, "supervisor_setup"))).toBe("protocol_failure");
		expect(controller.terminal).toMatchObject({ kind: "failed", phase: "supervisor_bootstrap" });
	});
});
