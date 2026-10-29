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

// #4272 S14 RULING-87: request context distinguishes gone tokens without changing wire advice.
it.each(["unknown_token", "released"] as const)(
	"immediately restarts exactly once for a token refused as %s",
	(reason) => {
		const controller = new RecoveryRepairController();
		const gone: RecoveryRepairAdvice = { ...failure, state: "repair_needed", healthRevision: null, source: null };
		const context = { token: "first", reason };

		expect(controller.observe(gone, 0, context)).toEqual({ action: "restart_from_catalog" });
		for (const now of [0, 500, 10_000])
			expect(controller.observe(gone, now, context)).toEqual({ action: "wait", retryAfterMs: 500 });
	},
);

it("backs off when the fresh cut is also unknown, then restarts that token only once", () => {
	const controller = new RecoveryRepairController();
	const gone: RecoveryRepairAdvice = { ...failure, state: "repair_needed", healthRevision: null, source: null };
	const first = { token: "first", reason: "unknown_token" } as const;
	const second = { token: "fresh", reason: "unknown_token" } as const;

	expect(controller.observe(gone, 0, first).action).toBe("restart_from_catalog");
	expect(controller.observe(gone, 1, second)).toEqual({ action: "wait", retryAfterMs: 500 });
	expect(controller.observe(gone, 500, second)).toEqual({ action: "wait", retryAfterMs: 100 });
	expect(controller.observe(gone, 501, second)).toEqual({ action: "restart_from_catalog" });
	expect(controller.observe(gone, 10_000, second).action).toBe("wait");
	expect(controller.observe(gone, 10_000, first).action).toBe("wait");
});

it("keeps storage failures change-gated even with gone-token request context", () => {
	const controller = new RecoveryRepairController();
	const context = { token: "first", reason: "unknown_token" } as const;

	expect(controller.observe(failure, 0, context)).toEqual({ action: "wait", retryAfterMs: 500 });
	expect(controller.observe(failure, 10_000, context).action).toBe("wait");
	expect(controller.observe({ ...failure, healthRevision: "4" }, 10_000, context).action).toBe("restart_from_catalog");
});

it("allows a later gone token an immediate restart after a successful page, but never repeats an old token", () => {
	const controller = new RecoveryRepairController();
	const gone: RecoveryRepairAdvice = { ...failure, state: "repair_needed" };
	const first = { token: "first", reason: "released" } as const;
	const later = { token: "later", reason: "released" } as const;

	expect(controller.observe(gone, 0, first).action).toBe("restart_from_catalog");
	expect(controller.observe({ ...failure, state: "ok" }, 1).action).toBe("ready");
	expect(controller.observe(gone, 2, first).action).toBe("wait");
	expect(controller.observe({ ...failure, state: "ok" }, 3).action).toBe("ready");
	expect(controller.observe(gone, 4, later).action).toBe("restart_from_catalog");
});
