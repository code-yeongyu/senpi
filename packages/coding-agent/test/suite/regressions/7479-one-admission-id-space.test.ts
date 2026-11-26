import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#7479: a prompt's clientMessageId and a delivery's deliveryId are one admission id space per session. The second
// arrival of an id answers the first admission whichever command carries it, a different message under the id is the
// typed conflict, and a duplicate or a conflict answer carries the outcome and the id only.

const CANARY_A = "CANARY-7479-first-message";
const CANARY_B = "CANARY-7479-second-message";
const SENDER = { kind: "agent", session_id: "CANARY-7479-sender-session", name: "CANARY-7479-sender" } as const;

describe("one admission id space for prompts and deliveries (senpi#7479)", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async () => {
		const fixture = await createIdentityHarness();
		fixtures.push(fixture);
		fixture.harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		const entries = () => fixture.session.sessionManager.getEntries();
		const userMessages = () => entries().filter((entry) => entry.type === "message" && entry.message.role === "user");
		const deliveries = () =>
			entries().filter(
				(entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE,
			);
		return { fixture, userMessages, deliveries };
	};

	const delivery = (deliveryId: string, text: string) => ({
		type: "admit_external_message",
		deliveryId,
		text,
		sender: SENDER,
		deliverAs: "followUp",
		whenIdle: "queue",
	});

	it("answers a delivery that repeats a prompt's id and text as already admitted, writing nothing", async () => {
		const { fixture, userMessages, deliveries } = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: CANARY_A, clientMessageId: "x-1" });
		await Promise.all(rpc.handler.pendingPrompts());

		const reply = await rpc.send(delivery("x-1", CANARY_A));

		expect(reply).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		expect(userMessages()).toHaveLength(1);
		expect(deliveries()).toHaveLength(0);
	});

	it("answers a prompt that repeats a delivery's id and text as its first admission, running nothing", async () => {
		const { fixture, userMessages, deliveries } = await setup();
		const rpc = fixture.bind();
		expect(await rpc.send(delivery("x-2", CANARY_A))).toMatchObject({ success: true, data: { kind: "queued" } });

		const reply = await rpc.send({ type: "prompt", message: CANARY_A, clientMessageId: "x-2" });
		await Promise.all(rpc.handler.pendingPrompts());

		expect(reply).toMatchObject({ success: true });
		expect(userMessages()).toHaveLength(0);
		expect(JSON.stringify(reply)).not.toContain(SENDER.name);
		await rpc.send({ type: "prompt", message: "flush", clientMessageId: "x-flush" });
		await Promise.all(rpc.handler.pendingPrompts());
		expect(deliveries()).toHaveLength(1);
		expect(userMessages()).toHaveLength(1);
	});

	it("refuses a different message under the same id on both commands, and names neither message", async () => {
		const { fixture, userMessages, deliveries } = await setup();
		const rpc = fixture.bind();
		await rpc.send({ type: "prompt", message: CANARY_A, clientMessageId: "x-3" });
		await Promise.all(rpc.handler.pendingPrompts());

		const asDelivery = await rpc.send(delivery("x-3", CANARY_B));

		expect(asDelivery).toMatchObject({ success: true, data: { kind: "id_conflict", deliveryId: "x-3" } });
		expect(Object.keys((asDelivery as { data: object }).data).sort()).toEqual(["deliveryId", "kind"]);
		expect(await rpc.send(delivery("x-4", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		const asPrompt = await rpc.send({ type: "prompt", message: CANARY_B, clientMessageId: "x-4" });

		expect(asPrompt).toMatchObject({ success: false, errorCode: "client_message_id_conflict" });
		for (const answer of [asDelivery, asPrompt]) {
			const text = JSON.stringify(answer);
			for (const canary of [CANARY_A, CANARY_B, SENDER.name, SENDER.session_id]) expect(text).not.toContain(canary);
		}
		expect(userMessages()).toHaveLength(1);
		expect(deliveries()).toHaveLength(0);
	});

	it("keeps the shared book across a reopen of the session file", async () => {
		const { fixture } = await setup();
		const first = fixture.bind();
		await first.send({ type: "prompt", message: CANARY_A, clientMessageId: "x-5" });
		await Promise.all(first.handler.pendingPrompts());

		const reopened = await fixture.reopen();

		expect(await reopened.send(delivery("x-5", CANARY_A))).toMatchObject({ data: { kind: "already_admitted" } });
		expect(await reopened.send(delivery("x-5", CANARY_B))).toMatchObject({ data: { kind: "id_conflict" } });
	});

	it("admits a delivery again once the engine cleared it unwritten, and runs it once", async () => {
		const { fixture, deliveries } = await setup();
		const rpc = fixture.bind();
		expect(await rpc.send(delivery("x-6", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		expect(await rpc.send({ type: "clear_queue" })).toMatchObject({ success: true });

		const redelivered = await rpc.send(delivery("x-6", CANARY_A));
		await rpc.send({ type: "prompt", message: "flush", clientMessageId: "x-flush-6" });
		await Promise.all(rpc.handler.pendingPrompts());

		expect(redelivered).toMatchObject({ success: true, data: { kind: "queued" } });
		expect(deliveries()).toHaveLength(1);
	});

	it("never admits a written delivery again, on the same session object or after a reopen", async () => {
		const { fixture, deliveries } = await setup();
		const rpc = fixture.bind();
		expect(await rpc.send(delivery("x-7", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		await rpc.send({ type: "prompt", message: "flush", clientMessageId: "x-flush-7" });
		await Promise.all(rpc.handler.pendingPrompts());
		expect(deliveries()).toHaveLength(1);
		expect(await rpc.send({ type: "clear_queue" })).toMatchObject({ success: true });

		const inProcess = await rpc.send(delivery("x-7", CANARY_A));
		const reopened = await fixture.reopen();
		const afterReopen = await reopened.send(delivery("x-7", CANARY_A));

		expect(inProcess).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		expect(afterReopen).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		expect(
			fixture.session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message"),
		).toHaveLength(1);
	});

	it("answers a duplicate of a written delivery with its turn id in process, and without one after a reopen", async () => {
		const { fixture } = await setup();
		const rpc = fixture.bind();
		expect(await rpc.send(delivery("x-8", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		await rpc.send({ type: "prompt", message: "flush", clientMessageId: "x-flush-8" });
		await Promise.all(rpc.handler.pendingPrompts());

		const inProcess = (await rpc.send(delivery("x-8", CANARY_A))) as { data: Record<string, unknown> };
		const reopened = await fixture.reopen();
		const afterReopen = (await reopened.send(delivery("x-8", CANARY_A))) as { data: Record<string, unknown> };

		expect(inProcess.data).toMatchObject({ kind: "already_admitted", turnId: expect.any(String) });
		expect(afterReopen.data).toEqual({ kind: "already_admitted" });
	});

	it("admits ids that differ only by the class the sender derived them for, each once", async () => {
		const { fixture, deliveries } = await setup();
		const rpc = fixture.bind();

		expect(await rpc.send(delivery("owner:k-1", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		expect(await rpc.send(delivery("connector:k-1", CANARY_A))).toMatchObject({ data: { kind: "queued" } });
		await rpc.send({ type: "prompt", message: "flush", clientMessageId: "x-flush-2" });
		await Promise.all(rpc.handler.pendingPrompts());

		expect(deliveries()).toHaveLength(2);
	});
});
