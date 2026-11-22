import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { BatchConsent, CallOutcome, ConsentAnswer, ConsentRequest } from "../coordinator-types.ts";
import type { BatchCaseAdapters } from "./batch-executor.ts";
import { type BatchHarness, batchHarness, batchPlan } from "./batch-harness.ts";

type ConsentCase = CaseImplementation<BatchCaseAdapters>;

/** A lease that has ended: the harness admits every call with a 60 s lease. */
const PAST_LEASE_MS = 120_000;

/** An approver that hands each request to the case and answers when the case says so. */
export function scriptedConsent(needsConsent: (name: string) => boolean = () => false) {
	const requests: ConsentRequest[] = [];
	const waiting: { request: ConsentRequest; answer: (given: ConsentAnswer) => void }[] = [];
	const asked = Promise.withResolvers<void>();
	const port: BatchConsent = {
		needsConsent: ({ name }) => needsConsent(name),
		approve: (request) => {
			requests.push(request);
			const answered = Promise.withResolvers<ConsentAnswer>();
			waiting.push({ request, answer: answered.resolve });
			asked.resolve();
			return answered.promise;
		},
	};
	return {
		port,
		requests,
		asked: asked.promise,
		answer: (given: ConsentAnswer): void => {
			const next = waiting.shift();
			if (next === undefined) throw new Error("no consent request is waiting");
			next.answer(given);
		},
	};
}

/** S10's rule: a call settled during preparation ABORTs the rest as an interrupted preparation (replayed as today). */
const notRun: CallOutcome = { kind: "not_run", cause: "interrupted_preparation" };

async function expiredWhileAwaiting(h: BatchHarness, answer: ConsentAnswer, lateApproval: boolean): Promise<void> {
	const plan = batchPlan(lateApproval ? "consent-02" : "consent-01", [
		["a", "e1"],
		["g", "e1", "gated"],
		["c", "e2"],
	]);
	const approver = scriptedConsent();
	const run = (await h.brain(undefined, "brain", approver.port)).run(plan);
	await approver.asked;
	h.advance(PAST_LEASE_MS);
	approver.answer(answer);
	const result = await run;
	const expired: CallOutcome = { kind: "interrupted", reason: "lease_expired", uncertain: true };
	expectEqual(result, { decision: "ABORT", outcomes: [notRun, expired, notRun] }, "lease_expired, the rest ABORTed");
	expectEqual(
		approver.requests.map(({ executionId, gate }) => [executionId, gate]),
		[["g", "frozen"]],
		"one approval request, bound to the frozen call",
	);
	expectEqual(h.count("body:a") + h.count("body:g") + h.count("body:c"), 0, "no body ran");
	expectEqual(h.count("shim:g"), 1, "no automatic successor: g was never prepared again");
	const frozenDigest = approver.requests[0]?.digest ?? "";
	const late = await h.executor("e1").consent?.({ issuer: "brain", executionId: "g", generation: 1 }, frozenDigest);
	expectEqual(
		late?.kind === "settled" ? late.outcome.reason : late?.kind,
		"lease_expired",
		"a later approval is rejected with the endpoint's own lease_expired outcome",
	);
	expectEqual(await h.ledgerState("e1", "g"), "settled", "the endpoint is terminal");
	expectEqual(await (await h.brain(undefined, "brain", approver.port)).run(plan), result, "recovery decides the same");
	expectEqual(approver.requests.length, 1, "recovery asks nobody again");
}

/** CONSENT-01 (S12, cross-machine): the lease expires while g awaits Gate B consent. */
const expiryWhileAwaiting: ConsentCase = async (adapters) =>
	expiredWhileAwaiting(await batchHarness(adapters), "expired", false);

/** CONSENT-02 (S12, cross-machine): the approval for g arrives after its lease expired, and is rejected. */
const lateApproval: ConsentCase = async (adapters) =>
	expiredWhileAwaiting(await batchHarness(adapters), "approved", true);

export const CONSENT_CASES: ReadonlyMap<string, ConsentCase> = new Map([
	["CONSENT-01", expiryWhileAwaiting],
	["CONSENT-02", lateApproval],
]);
