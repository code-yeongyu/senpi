import type { CaseImplementation } from "../../conformance/runner.ts";
import { expectEqual } from "../../durable/testing/store-harness.ts";
import { texts } from "./epoch-cases.ts";
import { openEpochRig } from "./epoch-harness.ts";
import { call, type HandCaseAdapters } from "./hand-harness.ts";

const SCOPES = ["a", "b", "c"];

/** Z2: one session moves (its scope's floor rises); the other sessions' scopes on the same hand keep running. */
const oneSessionMoves: CaseImplementation<HandCaseAdapters> = async (adapters) => {
	const rig = await openEpochRig(adapters, {
		brains: [
			{ name: "brain-old", epoch: 1 },
			{ name: "brain-new", epoch: 2 },
		],
	});
	for (const scope of SCOPES) rig.setOwner(scope, "brain-old");
	await rig.settle(
		Promise.all(SCOPES.map((scope) => rig.execute("brain-old", scope, [call(`${scope}1`)]))),
		"MULTI-EPOCH-01: every scope ran on the old owner",
	);
	rig.setOwner("a", "brain-new");
	const moved = await rig.settle(rig.execute("brain-new", "a", [call("a2")]), "MULTI-EPOCH-01: scope a moved");
	expectEqual(texts(moved), ["ran:a2"], "MULTI-EPOCH-01: the moved scope runs on its new owner");
	const after = await rig.settle(
		Promise.all(SCOPES.map((scope) => rig.execute("brain-old", scope, [call(`${scope}3`)]))),
		"MULTI-EPOCH-01: the old owner's next calls",
	);
	expectEqual(
		after.map(texts),
		[["The hand refused this tool call: epoch_fenced"], ["ran:b3"], ["ran:c3"]],
		"MULTI-EPOCH-01: only the moved scope fences the old owner; the others run untouched",
	);
	for (const scope of ["b", "c"])
		expectEqual(await rig.floor(scope), { epoch: 1, owner: "brain-old" }, `MULTI-EPOCH-01: scope ${scope}'s floor`);
	expectEqual(
		[...rig.bodies].sort(),
		["a1", "a2", "b1", "b3", "c1", "c3"].map((id) => `${id.charAt(0)}:${id}`),
		"MULTI-EPOCH-01: every scope's calls ran once; the fenced one never ran",
	);
};

export const MULTI_EPOCH_CASES: ReadonlyMap<string, CaseImplementation<HandCaseAdapters>> = new Map([
	["MULTI-EPOCH-01", oneSessionMoves],
]);
