import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import {
	createCarrierFault,
	FAULT_PROFILE_NAMES,
	type FaultProfileName,
	type FaultStats,
} from "../../transport/testing/fault-transport.ts";
import { call, type HandCaseAdapters, openHandRig } from "./hand-harness.ts";

type HandCase = CaseImplementation<HandCaseAdapters>;

const SCOPES = ["a", "b"];
const CALLS = 12;
const PACE_MS = 20;
const ids = (scope: string): string[] => Array.from({ length: CALLS }, (_, index) => `${scope}${index + 1}`);
const texts = (messages: readonly ToolResultMessage[]): string[] =>
	messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

const acted: Record<FaultProfileName, (stats: FaultStats) => boolean> = {
	slow: (stats) => stats.refused > 0,
	lossy: (stats) => stats.lost > 0,
	laggy: (stats) => stats.reordered > 0,
	flap: (stats) => stats.drops >= 2,
	"drop-reattach": (stats) => stats.drops >= 2,
};

/**
 * Calls of two scopes sent one by one across the faulted link: every call settles with exactly the result an unfaulted
 * run gives, each body runs once, and each scope's calls start in their lane order.
 */
const underProfile =
	(name: FaultProfileName): HandCase =>
	async (adapters) => {
		const stats: FaultStats = { refused: 0, lost: 0, reordered: 0, drops: 0 };
		const rig = await openHandRig(adapters, { placement: "cross-machine", fault: createCarrierFault(name, stats) });
		const what = `FAULT-HAND ${name}`;
		const batches: Array<Promise<{ readonly messages: ToolResultMessage[] }>> = [];
		for (let index = 0; index < CALLS; index++) {
			for (const scope of SCOPES) batches.push(rig.execute(scope, [call(ids(scope)[index] ?? "")], "sequential"));
			await rig.timers.advanceTo(rig.timers.now() + PACE_MS);
		}
		const results = await rig.settle(Promise.all(batches), `${what}: every call settled`);
		expectEqual(
			results.flatMap(({ messages }) => texts(messages)).sort(),
			SCOPES.flatMap((scope) => ids(scope).map((id) => `ran:${id}`)).sort(),
			`${what}: results equal the unfaulted run`,
		);
		for (const scope of SCOPES)
			expectEqual(
				rig.bodies.filter((body) => body.startsWith(`${scope}:`)),
				ids(scope).map((id) => `${scope}:${id}`),
				`${what}: scope ${scope} ran each call once, in lane order`,
			);
		expectEqual(rig.faults, [], `${what}: the hand reported no fault`);
		if (!acted[name](stats)) throw new Error(`${what}: the profile never acted (${JSON.stringify(stats)})`);
	};

/**
 * The hand becomes unreachable for far longer than the transport's resume window while several sessions' calls run on
 * it: every dependent call pauses (no outcome is invented and nothing reruns), and after the hand is reachable again each
 * scope's call settles exactly once with its own result.
 */
const unreachableThenBack: HandCase = async (adapters) => {
	const rig = await openHandRig(adapters, { placement: "cross-machine" });
	rig.gateBodies();
	const settledScopes = new Set<string>();
	const batches = SCOPES.map((scope) => {
		const batch = rig.execute(scope, [call(`${scope}1`)]);
		void batch.then(() => settledScopes.add(scope));
		return batch;
	});
	await rig.runUntil(() => rig.bodies.length === SCOPES.length, "FAULT-HAND-MULTI-01: every scope's call is running");
	rig.disconnect();
	for (const scope of SCOPES) rig.release(`${scope}1`);
	await rig.timers.advanceTo(rig.timers.now() + 60_000);
	expectEqual([...settledScopes], [], "FAULT-HAND-MULTI-01: dependent calls pause while the hand is unreachable");
	rig.reconnect();
	const results = await rig.settle(Promise.all(batches), "FAULT-HAND-MULTI-01: every scope resumed after reconnect");
	expectEqual(
		results.map(({ messages }) => texts(messages)),
		SCOPES.map((scope) => [`ran:${scope}1`]),
		"FAULT-HAND-MULTI-01: each scope settled with its own result",
	);
	await rig.timers.advanceTo(rig.timers.now() + 5_000);
	expectEqual(
		rig.bodies,
		SCOPES.map((scope) => `${scope}:${scope}1`),
		"FAULT-HAND-MULTI-01: resumed once: no body ran twice",
	);
	expectEqual(rig.faults, [], "FAULT-HAND-MULTI-01: the hand reported no fault");
};

export const FAULT_HAND_CASES: ReadonlyMap<string, HandCase> = new Map([
	...FAULT_PROFILE_NAMES.map((name, index): [string, HandCase] => [`FAULT-HAND-0${index + 1}`, underProfile(name)]),
	["FAULT-HAND-MULTI-01", unreachableThenBack],
]);
