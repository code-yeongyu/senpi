import { mkdirSync, renameSync, rmdirSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getAssistantTexts, type HarnessOptions } from "./harness.ts";
import { createIdentityHarness } from "./rpc-client-identity-harness.ts";

// omo-desktop-app#1325 and senpi#1971: durable identity survives attachment and queue recovery.
describe("RPC client identity recovery", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});
	const setup = async (options: HarnessOptions = {}) => {
		const fixture = await createIdentityHarness(options);
		fixtures.push(fixture);
		fixture.harness.setResponses([
			fauxAssistantMessage("one"),
			fauxAssistantMessage("two"),
			fauxAssistantMessage("three"),
		]);
		return fixture;
	};

	it("joins a delivery in preflight across two connections", async () => {
		// Given
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let intercepted = 0;
		const fixture = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						intercepted++;
						entered.resolve();
						await release.promise;
						return { action: "continue" };
					});
				},
			],
		});
		const first = fixture.bind();
		const second = fixture.bind();
		const command = { type: "prompt", message: "once", clientMessageId: "concurrent" };
		const initial = first.send(command);
		await entered.promise;

		// When
		const duplicate = second.send(command);
		release.resolve();
		const responses = await Promise.all([initial, duplicate]);
		await Promise.all(first.handler.pendingPrompts());

		// Then
		expect(responses.every((response) => response.success === true)).toBe(true);
		expect(intercepted).toBe(1);
		expect(getAssistantTexts(fixture.harness)).toEqual(["one"]);
	});

	it("returns the running admission while the provider is held", async () => {
		// Given
		const fixture = await setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const stream = fixture.harness.agent.streamFunction;
		fixture.harness.agent.streamFunction = async (model, context, options) => {
			entered.resolve();
			await release.promise;
			return stream(model, context, options);
		};
		const rpc = fixture.bind();
		const command = { type: "prompt", message: "held", clientMessageId: "running" };
		let repeated: Awaited<ReturnType<typeof rpc.send>>;
		try {
			await rpc.send(command);
			await entered.promise;

			// When
			repeated = await rpc.send(command);
		} finally {
			release.resolve();
		}
		await Promise.all(rpc.handler.pendingPrompts());

		// Then
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "running" } } });
		expect(getAssistantTexts(fixture.harness)).toEqual(["one"]);
	});

	it("restores prepared queues once without repeating input transforms", async () => {
		// Given
		let transformations = 0;
		const fixture = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						transformations++;
						return { action: "transform", text: `prepared:${event.text}` };
					});
				},
			],
		});
		const rpc = fixture.bind();
		const steering = { type: "steer", message: "same", clientMessageId: "steering", clientTurnId: "steer-turn" };
		const followUp = { type: "follow_up", message: "same", clientMessageId: "follow", clientTurnId: "follow-turn" };
		await rpc.send(followUp);
		await rpc.send(steering);
		const reopened = await fixture.reopen();

		// When
		await reopened.send(steering);
		await reopened.send(followUp);
		const state = await reopened.send({ type: "get_state" });

		// Then
		expect(transformations).toBe(2);
		expect(fixture.session.pendingMessageCount).toBe(2);
		expect(state).toMatchObject({
			data: {
				ordered: [
					{ text: "prepared:same", mode: "followUp", clientMessageId: "follow", enqueueOrder: 1 },
					{ text: "prepared:same", mode: "steer", clientMessageId: "steering", enqueueOrder: 2 },
				],
			},
		});
	});

	it("does not resurrect cleared input on redelivery after reopening", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		const command = { type: "follow_up", message: "cancelled", clientMessageId: "cancelled" };
		await rpc.send(command);
		const cleared = await rpc.send({ type: "clear_queue", abortWillFollow: true });
		const reopened = await fixture.reopen();

		// When
		const repeated = await reopened.send(command);

		// Then
		expect(cleared).toMatchObject({ data: { ordered: [{ clientMessageId: "cancelled" }] } });
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "completed" } } });
		expect(fixture.session.pendingMessageCount).toBe(0);
	});

	it("does not start work when the admission cannot be persisted", async () => {
		// Given
		const fixture = await setup();
		const rpc = fixture.bind();
		await rpc.handler.ready;
		await fixture.session.sessionManager.persistHeaderNow();
		const path = fixture.session.sessionFile;
		if (!path) throw new Error("Missing fixture transcript");
		renameSync(path, `${path}.saved`);
		mkdirSync(path);
		const command = { type: "prompt", message: "safe", clientMessageId: "storage" };

		// When
		let refused: Awaited<ReturnType<typeof rpc.send>>;
		try {
			refused = await rpc.send(command);
		} finally {
			rmdirSync(path);
			renameSync(`${path}.saved`, path);
		}

		// Then
		expect(refused).toMatchObject({ success: false });
		expect(fixture.session.messages.filter((message) => message.role === "user")).toHaveLength(0);
	});

	it.each([{ clientMessageId: "" }, { clientMessageId: 4 }, { clientTurnId: false }])(
		"rejects malformed correlation fields before admission: %j",
		async (identity) => {
			// Given
			const fixture = await setup();
			const rpc = fixture.bind();

			// When
			const response = await rpc.send({ type: "prompt", message: "invalid", ...identity });

			// Then
			expect(response).toMatchObject({ success: false });
			expect(fixture.session.messages).toHaveLength(0);
		},
	);

	it("treats the same client id in another durable session as a new delivery", async () => {
		// Given
		const first = await setup();
		const second = await setup();
		const left = first.bind();
		const right = second.bind();
		const command = { type: "prompt", message: "independent", clientMessageId: "shared" };
		await left.send(command);
		await Promise.all(left.handler.pendingPrompts());

		// When
		await right.send(command);
		await Promise.all(right.handler.pendingPrompts());

		// Then
		expect(getAssistantTexts(second.harness)).toEqual(["one"]);
	});

	it("retires an input cleared while its queued disposition is still pending", async () => {
		// Given
		const queued = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const fixture = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "continue" }));
					pi.on("input_disposition", async (event) => {
						if (event.disposition !== "queued") return;
						queued.resolve();
						await release.promise;
					});
				},
			],
		});
		const rpc = fixture.bind();
		const command = { type: "steer", message: "clear before ack", clientMessageId: "clear-race" };
		const pending = rpc.send(command);
		await queued.promise;

		// When
		try {
			await rpc.send({ type: "clear_queue" });
		} finally {
			release.resolve();
		}
		await pending;
		const reopened = await fixture.reopen();
		const repeated = await reopened.send(command);

		// Then
		expect(repeated).toMatchObject({ success: true, data: { admission: { state: "completed" } } });
		expect(fixture.session.pendingMessageCount).toBe(0);
	});
});
