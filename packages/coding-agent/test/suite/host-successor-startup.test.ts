/**
 * senpi#4602 (A-amended sections 1 and 4, N1): a successor enrolls its presenter (P7) after internal and observer
 * readiness and BEFORE it may take the predecessor's public endpoint (P6). The launcher grants publication only
 * after a validated P7 result, so a rejected, closed or expired enrollment ends the candidate while the
 * predecessor's public name, key and pointer were never touched. The presenter exchange itself starts only at P7,
 * and an uncoordinated successor waits for its public answer on the bounded legacy policy instead of 30 s.
 * Everything runs on the virtual startup clock.
 */
import { describe, expect, it } from "vitest";
import type { HostProtocolInfo } from "../../src/modes/rpc/host-decision.ts";
import { ENDPOINT_OWNER_FENCE_CAPABILITY } from "../../src/modes/rpc/host-decision.ts";
import { type StartupPhase, startStartupController } from "../../src/modes/rpc/host-startup-policy.ts";
import {
	driveSuccessorStartup,
	type PresenterResult,
	predecessorOwnerArgs,
} from "../../src/modes/rpc/host-successor-startup.ts";
import { virtualClock } from "./host-startup-clock-support.ts";

const BEFORE_PRESENTER: readonly StartupPhase[] = [
	"supervisor_bootstrap",
	"supervisor_setup",
	"host_bootstrap",
	"host_runtime",
	"internal_ready",
	"observer_ready",
];

const ANSWER = { instanceId: "succ", capabilities: [] } as unknown as HostProtocolInfo;

const REACHED_AT = [10_000, 20_000, 40_000, 50_000, 55_000, 62_000];

function reachPresenter(
	clock: ReturnType<typeof virtualClock>,
	controller: ReturnType<typeof startStartupController>,
	count = BEFORE_PRESENTER.length,
): void {
	for (const [index, phase] of BEFORE_PRESENTER.slice(0, count).entries()) {
		clock.advanceTo(REACHED_AT[index] ?? 0);
		expect(controller.complete(phase)).toBe("accepted");
	}
}

function settleTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function successor(presenter: (() => Promise<PresenterResult>) | undefined) {
	const clock = virtualClock();
	const controller = startStartupController({ launchKind: "successor", clock });
	const order: string[] = [];
	const answerBudgets: number[] = [];
	const granted = Promise.withResolvers<void>();
	const run = driveSuccessorStartup({
		attempt: {
			controller,
			coordinated: true,
			grant: async () => {
				order.push("grant");
				granted.resolve();
			},
		},
		presenter:
			presenter &&
			(() => {
				order.push("presenter");
				return presenter();
			}),
		awaitAnswer: async (budgetMs) => {
			answerBudgets.push(budgetMs);
			order.push("answer");
			return ANSWER;
		},
	});
	return { clock, controller, order, answerBudgets, granted: granted.promise, run };
}

describe("successor startup ordering (senpi#4602 N1)", () => {
	it("starts the presenter exchange only at P7, grants publication only after it enrolled, then verifies", async () => {
		const enrolled = Promise.withResolvers<PresenterResult>();
		const start = successor(() => enrolled.promise);
		reachPresenter(start.clock, start.controller, BEFORE_PRESENTER.length - 1);
		await settleTurn();
		expect(start.order).toEqual([]);
		start.clock.advanceTo(62_000);
		expect(start.controller.complete("observer_ready")).toBe("accepted");
		await settleTurn();
		expect(start.order).toEqual(["presenter"]);
		start.clock.advanceTo(80_000);
		enrolled.resolve("enrolled");
		await start.granted;
		expect(start.controller.phase).toBe("public_published");
		start.clock.advanceTo(81_000);
		expect(start.controller.complete("public_published")).toBe("accepted");
		const result = await start.run;
		expect(result.ready).toBe(true);
		expect(start.order).toEqual(["presenter", "grant", "answer"]);
		expect(start.answerBudgets).toEqual([10_000]);
	});

	it("a presenter channel that closes without enrolling fails the candidate in P7 and never grants publication", async () => {
		const start = successor(async () => "closed");
		reachPresenter(start.clock, start.controller);
		const result = await start.run;
		expect(result.ready).toBe(false);
		expect(!result.ready && result.outcome.phase).toBe("presenter_resolved");
		expect(start.order).toEqual(["presenter"]);
	});

	it("an enrollment that expires at 92 s fails P7 at its own deadline and never grants publication", async () => {
		const start = successor(() => new Promise<PresenterResult>(() => {}));
		reachPresenter(start.clock, start.controller);
		await settleTurn();
		start.clock.advanceTo(92_000);
		const result = await start.run;
		expect(!result.ready && result.outcome).toMatchObject({
			kind: "timeout",
			phase: "presenter_resolved",
			limit: "phase",
		});
		expect(start.order).toEqual(["presenter"]);
	});

	it("without a presenter, P7 resolves at once and publication is granted", async () => {
		const start = successor(undefined);
		reachPresenter(start.clock, start.controller);
		await start.granted;
		expect(start.controller.phase).toBe("public_published");
	});

	it("an uncoordinated successor waits for its public answer on the bounded 180 s policy, not 30 s", async () => {
		const clock = virtualClock();
		const budgets: number[] = [];
		const result = await driveSuccessorStartup({
			attempt: {
				controller: startStartupController({ launchKind: "legacy", clock }),
				coordinated: false,
				grant: async () => {
					throw new Error("an uncoordinated successor is never granted");
				},
			},
			presenter: undefined,
			awaitAnswer: async (budgetMs) => {
				budgets.push(budgetMs);
				return ANSWER;
			},
		});
		expect(result.ready).toBe(true);
		expect(budgets).toEqual([180_000]);
	});
});

describe("mixed-version first handoff (senpi#4602 Q1)", () => {
	const host = (capabilities: string[]) =>
		({ instanceId: "pred", capabilities, protocolVersion: 1 }) as unknown as HostProtocolInfo;

	it("names the predecessor's owner token only when the predecessor advertises the fence capability", () => {
		expect(predecessorOwnerArgs(host([ENDPOINT_OWNER_FENCE_CAPABILITY]))).toEqual(["--replace-owner", "pred"]);
		expect(predecessorOwnerArgs(host(["generation_handoff"]))).toEqual([]);
	});
});
