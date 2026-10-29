import { expect, it } from "vitest";
import { RecoveryRepairController } from "../src/recovery-repair.ts";
import type { RecoveryRepairAdvice } from "@earendil-works/pi-protocol";

// #4272 S14 RULING-84: policy only. RpcClient end-to-end wiring is S15a's blocking carry.
const failure: RecoveryRepairAdvice = {
	state: "storage_unavailable",
	healthRevision: "3",
	source: { sessionEpoch: "epoch", sequence: 7 },
	hint: "restart_from_catalog",
	retryAfterMs: 500,
};

it("never spins or re-cuts on an unchanged failure even after its backoff expires", () => {
	const controller = new RecoveryRepairController();
	expect(controller.observe(failure, 0)).toEqual({ action: "wait", retryAfterMs: 500 });
	for (let index = 1; index <= 100; index++) expect(controller.observe(failure, index * 1_000).action).toBe("wait");
});

it.each([
	{ healthRevision: "4", source: failure.source },
	{ healthRevision: "3", source: { sessionEpoch: "epoch", sequence: 8 } },
	{ healthRevision: "3", source: { sessionEpoch: "new-epoch", sequence: 7 } },
])("re-cuts only after backoff when either health or accepted source changes: %j", (change) => {
	const controller = new RecoveryRepairController();
	controller.observe(failure, 0);
	const recovered: RecoveryRepairAdvice = { ...failure, ...change, state: "ok", retryAfterMs: 0 };
	expect(controller.observe(recovered, 499).action).toBe("wait");
	expect(controller.observe(recovered, 500)).toEqual({ action: "restart_from_catalog" });
	expect(controller.observe(recovered, 501)).toEqual({ action: "ready" });
});

it.each(["repair_needed", "storage_unavailable"] as const)(
	"never requests a prompt resubmission or current-root fallback for %s",
	(state) => {
		const controller = new RecoveryRepairController();
		const advice = { ...failure, state };
		expect(controller.observe(advice, 0).action).toBe("wait");
		expect(controller.observe({ ...advice, healthRevision: "4" }, 1_000).action).toBe("restart_from_catalog");
	},
);
