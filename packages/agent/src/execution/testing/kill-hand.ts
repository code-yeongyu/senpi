import { TOOL_RESULT_PLACEHOLDER } from "@earendil-works/pi-ai";
import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { HandPlacement } from "../remote-tool-host.ts";
import { call, type HandCaseAdapters, type KillPoint, openHandRig } from "./hand-harness.ts";

/** The ledger commits one call makes on a hand, in order. */
const COMMITS = ["admit", "prepare", "effect", "freeze", "release", "dispatch", "settle", "ack"] as const;
const PLACEMENTS: readonly HandPlacement[] = ["split-local", "cross-machine"];

/** What survives a kill: the call's last durable commit decides its outcome (design 5.6.5 with its amendment). */
type Expected = { readonly outcome: "result" } | { readonly outcome: "restarted"; readonly uncertain: boolean };

function expectedAfter(lastDurable: number): Expected {
	if (lastDurable < 0) return { outcome: "result" };
	if (lastDurable <= 2) return { outcome: "restarted", uncertain: lastDurable >= 2 };
	if (lastDurable <= 4) return { outcome: "result" };
	if (lastDurable === 5) return { outcome: "restarted", uncertain: true };
	return { outcome: "result" };
}

/** How many times the body ran in total: once, or never when the kill came before it ran. */
function bodyRuns(kill: KillPoint, lastDurable: number): number {
	if (lastDurable >= 0 && lastDurable <= 2) return 0;
	if (lastDurable === 5) return kill.commit === 6 ? 1 : 0;
	return 1;
}

export interface KillHandDeclaration {
	readonly id: string;
	readonly operation: (typeof COMMITS)[number];
	readonly at: KillPoint["at"];
	readonly placement: HandPlacement;
	readonly expected: string;
}

function describeExpected(placement: HandPlacement, expected: Expected, runs: number): string {
	const body = runs === 0 ? "the tool never runs" : "the tool runs exactly once";
	if (expected.outcome === "result") return `the session gets the tool's result; ${body}`;
	return placement === "split-local"
		? `the session gets today's placeholder result, no uncertain outcome; ${body}`
		: `the session gets hand_restarted, ${expected.uncertain ? "uncertain" : "not uncertain"}, never rerun; ${body}`;
}

const cases = COMMITS.flatMap((operation, commit) =>
	(["before", "durable"] as const).flatMap((at) =>
		PLACEMENTS.map((placement) => {
			const kill: KillPoint = { commit, at };
			const lastDurable = at === "durable" ? commit : commit - 1;
			const expected = expectedAfter(lastDurable);
			const runs = bodyRuns(kill, lastDurable);
			const id = `KILL-HAND-${String(commit + 1).padStart(2, "0")}-${at === "before" ? "B" : "D"}-${placement === "split-local" ? "SL" : "XM"}`;
			const what = `${id} (${operation} ${at}, ${placement})`;
			const run: CaseImplementation<HandCaseAdapters> = async (adapters) => {
				const rig = await openHandRig(adapters, { placement, killAt: kill });
				const outcome = rig.execute("scope", [call("c1")]);
				await rig.settle(rig.killed, `${what}: the kill point fired`);
				await rig.restart();
				const { messages } = await rig.settle(outcome, `${what}: the session got the call's outcome`);
				await rig.advance(200);
				const [message] = messages;
				const text = message?.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				if (expected.outcome === "result") {
					expectEqual([text, message?.isError], ["ran:c1", false], `${what}: the tool's result`);
				} else if (placement === "split-local") {
					expectEqual([text, message?.isError], [TOOL_RESULT_PLACEHOLDER, false], `${what}: today's placeholder`);
				} else {
					expectEqual(
						message?.details,
						{ outcome: "hand_restarted", uncertain: expected.uncertain, hooksRan: expected.uncertain },
						`${what}: the endpoint outcome`,
					);
					expectEqual(message?.isError, true, `${what}: reported as an error`);
				}
				expectEqual(rig.bodies.length, runs, `${what}: tool body runs`);
				const rows = await rig.rows();
				expectEqual(
					rows.map((row) => row.progress.state),
					["acked"],
					`${what}: one durable record, acknowledged`,
				);
			};
			const declaration: KillHandDeclaration = {
				id,
				operation,
				at,
				placement,
				expected: `${placement}: kill ${at} the ${operation} commit; ${describeExpected(placement, expected, runs)}; one durable record`,
			};
			return { declaration, run };
		}),
	),
);

export const KILL_HAND_DECLARATIONS: readonly KillHandDeclaration[] = cases.map(({ declaration }) => declaration);
export const KILL_HAND_CASES: ReadonlyMap<string, CaseImplementation<HandCaseAdapters>> = new Map(
	cases.map(({ declaration, run }) => [declaration.id, run]),
);
