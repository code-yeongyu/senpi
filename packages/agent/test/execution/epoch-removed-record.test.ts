// senpi#6040 (invariant I5 of #6030): once the embedder removes a scope's owner record, the owner the hand last read
// is no longer the owner; its raise is refused, as before record reads existed, and the read it left is forgotten.
import { describe, expect, it } from "vitest";
import { createHandEpochFence, type ScopeOwner } from "../../src/execution/remote-epoch.ts";

describe("a removed owner record (senpi#6040)", () => {
	it("refuses the last-read owner once the record is gone", async () => {
		let record: ScopeOwner | undefined = { principal: "b", epoch: 2 };
		let copy: ScopeOwner | undefined = { principal: "a", epoch: 1 };
		const fence = createHandEpochFence({ ownerOf: () => copy, refreshOwner: async () => record });
		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "acked", floor: 2 });
		record = undefined;
		copy = undefined;

		expect(await fence.raise("s", 2, "b")).toEqual({ kind: "refused", reason: "peer_unauthorized" });
	});
});
