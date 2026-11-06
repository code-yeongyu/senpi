import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { texts } from "./epoch-cases.ts";
import { type CommitMatch, floorCommit, openEpochRig, stepCommit } from "./epoch-harness.ts";
import { call, type HandCaseAdapters } from "./hand-harness.ts";

export interface KillEpochDeclaration {
	readonly id: string;
	readonly expected: string;
}

interface KillPoint {
	readonly id: string;
	readonly match: CommitMatch;
	readonly at: "before" | "durable";
	/** The floor the store holds right after the kill: the new owner's only once its raise became durable. */
	readonly floorAfterKill: number;
	/** The new owner's call runs once, or (killed once its admission was durable) ends hand_restarted, never run. */
	readonly newCallRuns: boolean;
	readonly expected: string;
}

const OLD = { name: "brain-old", epoch: 1 };
const NEW = { name: "brain-new", epoch: 2 };
const FENCED = "the old owner stays fenced";

const POINTS: readonly KillPoint[] = [
	{
		id: "KILL-EPOCH-01-B",
		match: floorCommit("s", NEW.epoch),
		at: "before",
		floorAfterKill: OLD.epoch,
		newCallRuns: true,
		expected: `kill before the floor raise is durable: no ACK; the re-sent floor is acked after restart, the new call runs once, ${FENCED}`,
	},
	{
		id: "KILL-EPOCH-01-D",
		match: floorCommit("s", NEW.epoch),
		at: "durable",
		floorAfterKill: NEW.epoch,
		newCallRuns: true,
		expected: `kill once the floor is durable, before its ACK: the restarted hand holds the floor, the new call runs once, ${FENCED}`,
	},
	{
		id: "KILL-EPOCH-02-B",
		match: stepCommit(NEW.name, "admit"),
		at: "before",
		floorAfterKill: NEW.epoch,
		newCallRuns: true,
		expected: `kill after the ACK, before the new owner's first call is recorded: the floor survives, the call runs once, ${FENCED}`,
	},
	{
		id: "KILL-EPOCH-02-D",
		match: stepCommit(NEW.name, "admit"),
		at: "durable",
		floorAfterKill: NEW.epoch,
		newCallRuns: false,
		expected: `kill once the new owner's first call is recorded: the floor survives, the call ends hand_restarted and never runs, ${FENCED}`,
	},
];

const cases = POINTS.map((point) => {
	const run: CaseImplementation<HandCaseAdapters> = async (adapters) => {
		const what = point.id;
		const rig = await openEpochRig(adapters, { brains: [OLD, NEW], kill: { match: point.match, at: point.at } });
		rig.setOwner("s", OLD.name);
		await rig.settle(rig.execute(OLD.name, "s", [call("c0")]), `${what}: the old owner's first call`);
		rig.setOwner("s", NEW.name);
		const moved = rig.execute(NEW.name, "s", [call("c1")]);
		await rig.settle(rig.killed, `${what}: the kill point fired`);
		expectEqual(
			await rig.floor("s"),
			{ epoch: point.floorAfterKill, owner: point.floorAfterKill === NEW.epoch ? NEW.name : OLD.name },
			`${what}: the floor durable at the kill`,
		);
		await rig.restart();
		const result = await rig.settle(moved, `${what}: the new owner's call`);
		if (point.newCallRuns) expectEqual(texts(result), ["ran:c1"], `${what}: the new owner's call ran`);
		else
			expectEqual(
				result.messages[0]?.details,
				{ outcome: "hand_restarted", uncertain: false, hooksRan: false },
				`${what}: the recorded call ended hand_restarted, not uncertain`,
			);
		const delayed = await rig.settle(rig.execute(OLD.name, "s", [call("c2")]), `${what}: a delayed old-owner call`);
		expectEqual(delayed.messages[0]?.isError, true, `${what}: the old owner's delayed call is refused`);
		await rig.advance(200);
		expectEqual(rig.bodies, point.newCallRuns ? ["s:c0", "s:c1"] : ["s:c0"], `${what}: tool body runs`);
		expectEqual(
			(await rig.rows()).map(({ commandId, progress }) => [commandId, progress.state]),
			[
				["brain-new-1", "acked"],
				["brain-old-1", "acked"],
			],
			`${what}: one durable record per call that reached the ledger, acknowledged`,
		);
	};
	return { declaration: { id: point.id, expected: point.expected }, run };
});

export const KILL_EPOCH_DECLARATIONS: readonly KillEpochDeclaration[] = cases.map(({ declaration }) => declaration);
export const KILL_EPOCH_CASES: ReadonlyMap<string, CaseImplementation<HandCaseAdapters>> = new Map(
	cases.map(({ declaration, run }) => [declaration.id, run]),
);
