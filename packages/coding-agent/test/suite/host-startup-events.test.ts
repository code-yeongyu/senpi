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
import {
	STARTUP_PHASE_ALLOWANCE_MS,
	STARTUP_PROGRESS_STALL_MS,
	type StartupClock,
	startStartupController,
} from "../../src/modes/rpc/host-startup-policy.ts";
import { virtualClock } from "./host-startup-clock-support.ts";

const frozenClock: StartupClock = { now: () => 0, scheduleAt: () => undefined, cancel: () => {} };

function attempt(clock: StartupClock = frozenClock) {
	const binding: StartupBinding = {
		attempt: newStartupAttempt(),
		endpoint: "/tmp/senpi-test/host.sock",
		instanceId: "instance-1",
		generation: 0,
		launchKind: "initial",
		predecessor: null,
	};
	const controller = startStartupController({ launchKind: "initial", clock });
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

	describe("progress records", () => {
		/** An attempt on a virtual clock, already in supervisor_setup (entered at 1 s, allowance 15 s). */
		function inSetup() {
			const clock = virtualClock();
			const started = attempt(clock);
			clock.advanceTo(1_000);
			expect(started.supervisor(startupEventLine(started.binding, "supervisor", 1, "supervisor_bootstrap"))).toBe(
				"accepted",
			);
			return { clock, ...started };
		}

		it("keeps a slow supervisor that keeps reporting progress past its phase allowance", () => {
			const { clock, binding, controller, supervisor } = inSetup();
			let seq = 1;
			for (let at = 3_000; at <= 29_000; at += 2_000) {
				clock.advanceTo(at);
				expect(supervisor(startupEventLine(binding, "supervisor", ++seq, "progress"))).toBe("accepted");
			}
			expect(controller.terminal).toBeUndefined();
			expect(1_000 + STARTUP_PHASE_ALLOWANCE_MS.supervisor_setup).toBeLessThan(30_000);
			clock.advanceTo(30_000);
			expect(supervisor(startupEventLine(binding, "supervisor", ++seq, "supervisor_setup"))).toBe("accepted");
			expect(controller.phase).toBe("host_bootstrap");
			expect(controller.terminal).toBeUndefined();
		});

		it("still fails a supervisor whose progress stops, one stall bound after its last report", () => {
			const { clock, binding, controller, supervisor } = inSetup();
			let seq = 1;
			for (let at = 3_000; at <= 11_000; at += 2_000) {
				clock.advanceTo(at);
				expect(supervisor(startupEventLine(binding, "supervisor", ++seq, "progress"))).toBe("accepted");
			}
			clock.advanceTo(11_000 + STARTUP_PROGRESS_STALL_MS - 1);
			expect(controller.terminal).toBeUndefined();
			clock.advanceTo(11_000 + STARTUP_PROGRESS_STALL_MS);
			expect(controller.terminal).toEqual({
				kind: "timeout",
				phase: "supervisor_setup",
				limit: "stall",
				phaseBudgetMs: STARTUP_PHASE_ALLOWANCE_MS.supervisor_setup,
				elapsedMs: 11_000 + STARTUP_PROGRESS_STALL_MS,
			});
		});

		it("never extends a phase past twice its allowance, however long progress keeps coming", () => {
			const { clock, binding, controller, supervisor } = inSetup();
			const cap = 1_000 + 2 * STARTUP_PHASE_ALLOWANCE_MS.supervisor_setup;
			let seq = 1;
			for (let at = 3_000; at < cap; at += 2_000) {
				clock.advanceTo(at);
				supervisor(startupEventLine(binding, "supervisor", ++seq, "progress"));
			}
			clock.advanceTo(cap - 1);
			expect(controller.terminal).toBeUndefined();
			clock.advanceTo(cap);
			expect(controller.terminal).toEqual({
				kind: "timeout",
				phase: "supervisor_setup",
				limit: "phase",
				phaseBudgetMs: STARTUP_PHASE_ALLOWANCE_MS.supervisor_setup,
				elapsedMs: cap,
			});
		});

		it("labels a timeout a stall only when progress had moved the deadline", () => {
			const clock = virtualClock();
			const { binding, controller, supervisor } = attempt(clock);
			clock.advanceTo(5_000);
			expect(supervisor(startupEventLine(binding, "supervisor", 1, "progress"))).toBe("accepted");
			clock.advanceTo(STARTUP_PHASE_ALLOWANCE_MS.supervisor_bootstrap);
			expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_bootstrap", limit: "phase" });
		});

		it("does not extend a phase from the producer that does not own it", () => {
			const { clock, binding, controller, host } = inSetup();
			clock.advanceTo(10_000);
			expect(host(startupEventLine(binding, "host", 1, "progress"))).toBe("ignored");
			clock.advanceTo(1_000 + STARTUP_PHASE_ALLOWANCE_MS.supervisor_setup);
			expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_setup", limit: "phase" });
		});

		it("never carries an attempt past the overall decision budget", () => {
			const clock = virtualClock();
			const binding = attempt().binding;
			const controller = startStartupController({ launchKind: "initial", clock, decisionBudgetMs: 20_000 });
			const supervisor = startupEventIngress(controller, binding, "supervisor");
			let seq = 0;
			for (let at = 2_000; at < 20_000; at += 2_000) {
				clock.advanceTo(at);
				supervisor(startupEventLine(binding, "supervisor", ++seq, "progress"));
			}
			clock.advanceTo(20_000);
			expect(controller.terminal).toMatchObject({
				kind: "timeout",
				phase: "supervisor_bootstrap",
				limit: "overall",
				elapsedMs: 20_000,
			});
		});
	});

	it("fails a producer milestone sent before its phase was granted", () => {
		const { binding, controller, supervisor } = attempt();
		expect(supervisor(startupEventLine(binding, "supervisor", 1, "supervisor_setup"))).toBe("protocol_failure");
		expect(controller.terminal).toMatchObject({ kind: "failed", phase: "supervisor_bootstrap" });
	});
});
