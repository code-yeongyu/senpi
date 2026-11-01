import { expect, it } from "vitest";
import type { RecoveryCheckpoints } from "../../../src/modes/rpc/compact-recovery-state.ts";
import {
	ROUTE_RETIRE_REASONS,
	RouteAnnouncement,
	type AnnouncedRetire,
} from "../../../src/modes/rpc/route-retire-reasons.ts";

// RULING-119 (#5274): every reason a route retires for is classified, and an engine-side reason reaches `retireRoute`
// only through the helper that emits its typed record first. A new retire site must name one of these to compile.
it("RULING-119 every route retire reason is classified as a client action or an announced end", () => {
	expect(Object.keys(ROUTE_RETIRE_REASONS).length).toBeGreaterThan(0);
	for (const [reason, kind] of Object.entries(ROUTE_RETIRE_REASONS))
		expect(["client_action", "announced"], reason).toContain(kind);
});

it("RULING-119 an announced retire's proof exists only after its typed record was emitted", () => {
	const order: string[] = [];
	const announced = Object.entries(ROUTE_RETIRE_REASONS).flatMap(([reason, kind]) =>
		kind === "announced" ? [reason as AnnouncedRetire] : [],
	);
	expect(announced.length).toBeGreaterThan(0);
	for (const reason of announced) {
		const proof = RouteAnnouncement.emit(reason, () => order.push(`emit ${reason}`));
		order.push(`proof ${proof.reason}`);
	}
	expect(order).toEqual(announced.flatMap((reason) => [`emit ${reason}`, `proof ${reason}`]));
});

it("RULING-119 retireRoute refuses an announced reason that was never emitted (compile-time guard)", () => {
	const retire = (checkpoints: RecoveryCheckpoints) => {
		checkpoints.retireRoute({ socketEpoch: "s", sessionId: "x" }, "a", "client_detach");
		// @ts-expect-error RULING-119: an engine-side end needs a RouteAnnouncement, never its bare reason.
		checkpoints.retireRoute({ socketEpoch: "s", sessionId: "x" }, "a", "open_ended");
		// @ts-expect-error RULING-119: an unclassified reason does not exist.
		checkpoints.retireRoute({ socketEpoch: "s", sessionId: "x" }, "a", "unclassified");
	};
	expect(typeof retire).toBe("function");
});
