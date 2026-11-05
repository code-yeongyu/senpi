import { describe, expect, it } from "vitest";
import { startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import { virtualClock } from "./host-startup-clock-support.ts";

describe("startup controller launch paths (senpi#4602)", () => {
	it("replaces the host child's phases with one 90 s opaque phase completed by the internal reply", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		controller.complete("supervisor_bootstrap");
		expect(controller.declareOpaqueHost()).toBe("accepted");
		clock.advanceTo(1_000);
		controller.complete("supervisor_setup");
		expect(controller.phase).toBe("opaque_host");
		clock.advanceTo(1_000 + 89_999);
		expect(controller.complete("internal_ready")).toBe("accepted");
		expect(controller.phase).toBe("observer_ready");
	});

	it("fails an opaque host that never answers at its 90 s allowance", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		controller.complete("supervisor_bootstrap");
		controller.declareOpaqueHost();
		controller.complete("supervisor_setup");
		clock.advanceTo(90_000);
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "opaque_host", phaseBudgetMs: 90_000 });
	});

	it("accepts the opaque declaration only during supervisor setup of an initial launch", () => {
		const early = startStartupController({ launchKind: "initial", clock: virtualClock() });
		expect(early.declareOpaqueHost()).toBe("rejected");
		const successor = startStartupController({ launchKind: "successor", clock: virtualClock() });
		successor.complete("supervisor_bootstrap");
		expect(successor.declareOpaqueHost()).toBe("rejected");
	});

	it("gives a legacy launch one public-ready phase of the whole budget", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "legacy", clock });
		expect(controller.phase).toBe("public_verified");
		clock.advanceTo(179_999);
		expect(controller.terminal).toBeUndefined();
		clock.advanceTo(180_000);
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "public_verified", phaseBudgetMs: 180_000 });
	});

	it("clips every deadline to a lowered decision budget", () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock, decisionBudgetMs: 300 });
		clock.advanceTo(300);
		expect(controller.terminal).toMatchObject({ kind: "timeout", phase: "supervisor_bootstrap", limit: "overall" });
	});

	it("resolves a phase wait when the phase is entered, and false once the attempt is terminal first", async () => {
		const clock = virtualClock();
		const controller = startStartupController({ launchKind: "initial", clock });
		const setup = controller.whenPhase("supervisor_setup");
		const verified = controller.whenPhase("public_verified");
		controller.complete("supervisor_bootstrap");
		expect(await setup).toBe(true);
		clock.advanceTo(30_000);
		expect(await verified).toBe(false);
		expect(await controller.settled()).toMatchObject({ kind: "timeout", phase: "supervisor_setup" });
	});
});
