import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

// `external_message_admitted` tells the session's extensions that a delivery was admitted, at admission and before any
// turn takes it, so an extension can act on a delivery while the session is busy or idle (oh-my-openagent#15221 row 25).
// It fires once per admitted delivery and never for one that was refused, and carries only the delivery's id and text.

type Admitted = { readonly type: string; readonly delivery_id: string; readonly text: string };

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function listening(): Promise<{ target: Harness; seen: Admitted[]; next: () => Promise<Admitted> }> {
	const seen: Admitted[] = [];
	const waiters: ((event: Admitted) => void)[] = [];
	const target = await createHarness({
		persistSession: true,
		extensionFactories: [
			(pi) => {
				pi.on("external_message_admitted", (event) => {
					seen.push(event);
					waiters.shift()?.(event);
				});
			},
		],
	});
	harnesses.push(target);
	return { target, seen, next: () => new Promise((resolve) => waiters.push(resolve)) };
}

async function holdTurn(target: Harness): Promise<{ release: () => void; settled: Promise<void> }> {
	const gate = Promise.withResolvers<void>();
	target.setResponses([
		async () => {
			await gate.promise;
			return fauxAssistantMessage("first reply");
		},
		fauxAssistantMessage("second reply"),
	]);
	const started = Promise.withResolvers<void>();
	const unsubscribe = target.session.subscribe((event) => {
		if (event.type !== "agent_start") return;
		unsubscribe();
		started.resolve();
	});
	const settled = target.session.prompt("start work");
	await started.promise;
	return { release: () => gate.resolve(), settled };
}

describe("external_message_admitted", () => {
	it("fires for a delivery queued behind a running turn while that turn is still running, with only its id and text", async () => {
		const { target, seen, next } = await listening();
		const turn = await holdTurn(target);
		const fired = next();
		expect(
			target.session.externalAdmission.admit({ delivery_id: "d-queued", text: "notice text", deliverAs: "followUp" })
				.kind,
		).toBe("queued");
		const event = await fired;
		expect(event).toEqual({ type: "external_message_admitted", delivery_id: "d-queued", text: "notice text" });
		expect(seen).toHaveLength(1);
		turn.release();
		await turn.settled;
	});

	it("fires once per delivery: a repeat answered already_admitted fires nothing more", async () => {
		const { target, seen, next } = await listening();
		const turn = await holdTurn(target);
		const admission = target.session.externalAdmission;
		const first = next();
		admission.admit({ delivery_id: "d-once", text: "one", deliverAs: "followUp" });
		await first;
		expect(admission.admit({ delivery_id: "d-once", text: "one", deliverAs: "followUp" }).kind).toBe(
			"already_admitted",
		);
		const later = next();
		admission.admit({ delivery_id: "d-later", text: "two", deliverAs: "followUp" });
		await later;
		expect(seen.map((event) => event.delivery_id)).toEqual(["d-once", "d-later"]);
		turn.release();
		await turn.settled;
	});

	it("does not fire for a refused delivery: a steer naming another turn is turn_conflict and nothing is admitted", async () => {
		const { target, seen, next } = await listening();
		const turn = await holdTurn(target);
		const admission = target.session.externalAdmission;
		expect(
			admission.admit({ delivery_id: "d-refused", text: "no", deliverAs: "steer", expected_turn_id: 99 }).kind,
		).toBe("turn_conflict");
		const marker = next();
		admission.admit({ delivery_id: "d-after", text: "yes", deliverAs: "followUp" });
		await marker;
		expect(seen.map((event) => event.delivery_id)).toEqual(["d-after"]);
		turn.release();
		await turn.settled;
	});

	it("does not fire when admission is closed: the admit throws and nothing is admitted", async () => {
		const { target, seen, next } = await listening();
		const turn = await holdTurn(target);
		const admission = target.session.externalAdmission;
		admission.close("released");
		expect(() => admission.admit({ delivery_id: "d-closed", text: "no", deliverAs: "followUp" })).toThrow("released");
		admission.reopen();
		const marker = next();
		admission.admit({ delivery_id: "d-open", text: "yes", deliverAs: "followUp" });
		await marker;
		expect(seen.map((event) => event.delivery_id)).toEqual(["d-open"]);
		turn.release();
		await turn.settled;
	});
});
