import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { call, type HandCaseAdapters, openHandRig } from "./hand-harness.ts";

type HandCase = CaseImplementation<HandCaseAdapters>;

const SCOPES = ["a", "b", "c"];
const CALLS_PER_SCOPE = 3;
const callIds = (scope: string): string[] =>
	Array.from({ length: CALLS_PER_SCOPE }, (_, index) => `${scope}${index + 1}`);
const texts = (messages: readonly ToolResultMessage[]): string[] =>
	messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

/** Several sessions' scopes run batches at once on one hand: each scope's calls start in its lane order. */
const manyScopesOnOneHand: HandCase = async (adapters) => {
	const rig = await openHandRig(adapters, { placement: "split-local" });
	rig.gateBodies();
	const batches = SCOPES.map((scope) => rig.execute(scope, callIds(scope).map(call)));
	await rig.runUntil(() => rig.bodies.length === SCOPES.length * CALLS_PER_SCOPE, "MULTI-HAND-01: every body started");
	for (const scope of SCOPES)
		expectEqual(
			rig.bodies.filter((body) => body.startsWith(`${scope}:`)),
			callIds(scope).map((id) => `${scope}:${id}`),
			`MULTI-HAND-01: scope ${scope} kept its lane order`,
		);
	for (const scope of [...SCOPES].reverse()) for (const id of [...callIds(scope)].reverse()) rig.release(id);
	const results = await rig.settle(Promise.all(batches), "MULTI-HAND-01: every batch settled");
	expectEqual(
		results.map(({ messages }) => texts(messages)),
		SCOPES.map((scope) => callIds(scope).map((id) => `ran:${id}`)),
		"MULTI-HAND-01: each scope's results in its source order",
	);
};

/** A hand killed with several scopes' calls in flight: each scope recovers on its own, nothing runs twice. */
const killWithScopesInFlight: HandCase = async (adapters) => {
	const dispatchCommits = SCOPES.length * 6;
	const rig = await openHandRig(adapters, {
		placement: "cross-machine",
		killAt: { commit: dispatchCommits, at: "before" },
	});
	rig.gateBodies();
	const batches = SCOPES.map((scope) => rig.execute(scope, [call(`${scope}1`)]));
	await rig.runUntil(() => rig.bodies.length === SCOPES.length, "MULTI-KILL-01: every scope's call is running");
	rig.release("a1");
	await rig.settle(rig.killed, "MULTI-KILL-01: the hand died while the scopes were in flight");
	await rig.restart();
	const results = await rig.settle(Promise.all(batches), "MULTI-KILL-01: every scope got its outcome");
	expectEqual(
		results.map(({ messages }) => messages.map((message) => message.details)),
		SCOPES.map(() => [{ outcome: "hand_restarted", uncertain: true, hooksRan: true }]),
		"MULTI-KILL-01: each scope's call ended hand_restarted, uncertain",
	);
	expectEqual(
		rig.bodies,
		SCOPES.map((scope) => `${scope}:${scope}1`),
		"MULTI-KILL-01: no call ran twice",
	);
	await rig.advance(200);
	expectEqual(
		(await rig.rows()).map((row) => row.progress.state),
		SCOPES.map(() => "acked"),
		"MULTI-KILL-01: one durable record per call, acknowledged",
	);
};

export const MULTI_HAND_CASES: ReadonlyMap<string, HandCase> = new Map([
	["MULTI-HAND-01", manyScopesOnOneHand],
	["MULTI-KILL-01", killWithScopesInFlight],
]);
