import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import type { ToolHostResult } from "../tool-host.ts";
import { floorCommit, openEpochRig, stepCommit } from "./epoch-harness.ts";
import { call, type HandCaseAdapters } from "./hand-harness.ts";

type EpochCase = CaseImplementation<HandCaseAdapters>;

export const texts = ({ messages }: ToolHostResult): string[] =>
	messages.map((message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join(""));

const OLD = { name: "brain-old", epoch: 1 };
const NEW = { name: "brain-new", epoch: 2 };

/** SC-MOVE step 1: while the hand's floor ACK is held, the new owner's call has no effect, then runs once. */
const floorAckBarrier: EpochCase = async (adapters) => {
	const rig = await openEpochRig(adapters, { brains: [OLD, NEW] });
	rig.setOwner("s", OLD.name);
	const before = await rig.settle(rig.execute(OLD.name, "s", [call("c0")]), "EPOCH-01: the first owner's call");
	expectEqual(texts(before), ["ran:c0"], "EPOCH-01: the first owner runs on its floor");
	rig.setOwner("s", NEW.name);
	const barrier = rig.hold(floorCommit("s", NEW.epoch));
	const moved = rig.execute(NEW.name, "s", [call("c1")]);
	await rig.settle(barrier.reached, "EPOCH-01: the new owner's floor reached the hand's store");
	await rig.advance(2_000);
	expectEqual(rig.bodies, ["s:c0"], "EPOCH-01: nothing of the new owner's call ran while its floor ACK was held");
	expectEqual((await rig.rows()).length, 1, "EPOCH-01: the new owner's call was not even recorded");
	barrier.release();
	expectEqual(texts(await rig.settle(moved, "EPOCH-01: the new owner's call")), ["ran:c1"], "EPOCH-01: result");
	expectEqual(rig.bodies, ["s:c0", "s:c1"], "EPOCH-01: the new owner's call ran exactly once after the ACK");
};

/** SC-MOVE step 2: two brains claim the session at once; exactly one wins, and only the winner's calls run. */
const concurrentClaims: EpochCase = async (adapters) => {
	const first = { name: "brain-first", epoch: 1 };
	const rivals = [
		{ name: "brain-a", epoch: 2 },
		{ name: "brain-b", epoch: 2 },
	];
	const rig = await openEpochRig(adapters, { brains: [first, ...rivals] });
	rig.setOwner("s", first.name);
	await rig.settle(rig.execute(first.name, "s", [call("c0")]), "EPOCH-02: the first owner's call");
	const session = await adapters.store.createMedium();
	const opened = await Promise.all([0, 1, 2].map(() => adapters.store.open(session)));
	const [owner, ...claimants] = opened;
	await owner?.claim(0, 1);
	const claims = await Promise.allSettled(claimants.map((store) => store.claim(1, 2)));
	const won = rivals.filter((_, index) => claims[index]?.status === "fulfilled");
	expectEqual(won.length, 1, "EPOCH-02: exactly one of two concurrent CAS claims wins");
	const winner = won[0] ?? rivals[0];
	const loser = rivals.find((rival) => rival !== winner) ?? rivals[1];
	if (winner === undefined || loser === undefined) throw new Error("EPOCH-02: no rivals");
	rig.setOwner("s", winner.name);
	const [ran, refused] = await rig.settle(
		Promise.all([rig.execute(winner.name, "s", [call("cw")]), rig.execute(loser.name, "s", [call("cl")])]),
		"EPOCH-02: both claimants' calls",
	);
	expectEqual(texts(ran), ["ran:cw"], "EPOCH-02: the winner's call runs");
	expectEqual(
		[texts(refused), refused.messages[0]?.isError],
		[["The hand refused this session's epoch: peer_unauthorized"], true],
		"EPOCH-02: the loser's floor is refused and its call is never sent",
	);
	expectEqual(rig.bodies, ["s:c0", "s:cw"], "EPOCH-02: only the winner's call ran");
};

/** SC-MOVE step 3: an old owner's delayed walk (prepare, release) and a delayed invoke after the move are refused. */
const delayedOldOwner: EpochCase = async (adapters) => {
	const rig = await openEpochRig(adapters, { brains: [OLD, NEW] });
	rig.setOwner("s", OLD.name);
	await rig.settle(rig.execute(OLD.name, "s", [call("c0")]), "EPOCH-03: the old owner's first call");
	const prepare = rig.hold(stepCommit(OLD.name, "prepare"));
	const delayed = rig.execute(OLD.name, "s", [call("c2")]);
	await rig.settle(prepare.reached, "EPOCH-03: the old owner's delayed call is mid-walk");
	rig.setOwner("s", NEW.name);
	const moved = rig.execute(NEW.name, "s", [call("c1")]);
	await rig.advance(2_000);
	prepare.release();
	expectEqual(texts(await rig.settle(moved, "EPOCH-03: the new owner's call")), ["ran:c1"], "EPOCH-03: new owner");
	expectEqual(
		texts(await rig.settle(delayed, "EPOCH-03: the old owner's mid-walk call")),
		["The hand refused this tool call: epoch_fenced"],
		"EPOCH-03: the old owner's walk is refused at its next step",
	);
	const late = await rig.settle(rig.execute(OLD.name, "s", [call("c3")]), "EPOCH-03: a delayed old-owner invoke");
	expectEqual(texts(late), ["The hand refused this tool call: epoch_fenced"], "EPOCH-03: a delayed invoke is fenced");
	await rig.advance(200);
	const rows = await rig.rows();
	expectEqual(rig.bodies, ["s:c0", "s:c1"], "EPOCH-03: no old-owner call ran after the move");
	expectEqual(
		rows.map(({ commandId, progress }) => [
			commandId,
			progress.state === "settled" ? progress.outcome.reason : progress.state,
		]),
		[
			["brain-new-1", "acked"],
			["brain-old-1", "acked"],
			["brain-old-3", "cancelled"],
		],
		"EPOCH-03: the fenced walk's record is cancelled, never dispatched; the delayed invoke left no record",
	);
};

export const EPOCH_CASES: ReadonlyMap<string, EpochCase> = new Map([
	["EPOCH-01", floorAckBarrier],
	["EPOCH-02", concurrentClaims],
	["EPOCH-03", delayedOldOwner],
]);
