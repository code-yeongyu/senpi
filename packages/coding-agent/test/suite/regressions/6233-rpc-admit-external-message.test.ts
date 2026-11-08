import { CHAIN_COUNT_LIMIT } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_CONTROL_DELIVERY_TYPE } from "../../../src/core/extensions/session-control-types.ts";
import { classifyRpcMethod } from "../../../src/modes/rpc/method-classes.ts";
import { validateRpcInboundRecord } from "../../../src/modes/rpc/method-classes-schema.ts";
import { rpcCommandPayloadError } from "../../../src/modes/rpc/rpc-input-validation.ts";
import { createIdentityHarness } from "../rpc-client-identity-harness.ts";

// senpi#6233: a relayed peer-agent message is admitted over RPC as the engine's own session_control_delivery entry,
// exactly as pi.session.admitExternalMessage does in process: never a user message, never the input event, never a
// slash command or prompt template. A local connection's ids are keyed under "rpc:local/" (gate condition 4).
const PEER = { kind: "agent", session_id: "peer-session-1", name: "Peer" } as const;

describe("admit_external_message", () => {
	const fixtures: Awaited<ReturnType<typeof createIdentityHarness>>[] = [];
	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.cleanup();
	});

	const setup = async (options: { readonly hold?: boolean; readonly settings?: Record<string, unknown> } = {}) => {
		const inputs: string[] = [];
		const commands: string[] = [];
		const triggers: string[] = [];
		const fixture = await createIdentityHarness({
			...(options.settings === undefined ? {} : { fileSettings: true, settings: options.settings }),
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						inputs.push(event.text);
						return { action: "continue" };
					});
					pi.on("before_agent_start", (event) => {
						triggers.push(event.trigger);
					});
					pi.registerCommand("probe", {
						description: "Records that it ran",
						handler: async (args) => {
							commands.push(args);
						},
					});
				},
			],
		});
		fixtures.push(fixture);
		fixture.harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		if (options.hold === true) {
			const stream = fixture.harness.agent.streamFunction;
			fixture.harness.agent.streamFunction = async (model, context, streamOptions) => {
				entered.resolve();
				const aborted = new Promise<void>((resolve) =>
					streamOptions?.signal?.addEventListener("abort", () => resolve()),
				);
				await Promise.race([release.promise, aborted]);
				return stream(model, context, streamOptions);
			};
		}
		const rpc = fixture.bind();
		const deliveries = () =>
			fixture.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE);
		const userMessages = () =>
			fixture.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "user");
		return {
			fixture,
			rpc,
			inputs,
			commands,
			triggers,
			deliveries,
			userMessages,
			entered,
			release: () => release.resolve(),
		};
	};

	it("writes a session_control_delivery entry with the sender, never a user message, the input event or a command", async () => {
		// Given: an idle session whose extension watches input and registers /probe.
		const { fixture, rpc, inputs, commands, triggers, deliveries, userMessages } = await setup();

		// When: a relayed message that starts with a registered command is admitted.
		const reply = await rpc.send({
			type: "admit_external_message",
			deliveryId: "d1",
			text: "/probe run me",
			sender: PEER,
			displayText: "run me",
			deliverAs: "followUp",
		});
		await fixture.session.waitForIdle();

		// Then: it started a turn as the engine's delivery entry, carrying the sender, and nothing user-side ran.
		expect(reply).toMatchObject({
			success: true,
			command: "admit_external_message",
			data: { kind: "started", turnId: "0" },
		});
		expect(deliveries()).toEqual([
			expect.objectContaining({
				content: "/probe run me",
				details: expect.objectContaining({
					delivery_id: "rpc:local/d1",
					source: "session_control",
					deliverAs: "followUp",
					sender: PEER,
					display_text: "run me",
				}),
			}),
		]);
		expect(userMessages()).toEqual([]);
		expect(inputs).toEqual([]);
		expect(commands).toEqual([]);
		expect(triggers).toEqual(["delivery"]);
		expect(deliveries()[0]).not.toHaveProperty("details.remote_origin");
	});

	it("answers already_admitted for a delivery id it already holds and writes it once", async () => {
		const { fixture, rpc, deliveries } = await setup();
		const record = { type: "admit_external_message", deliveryId: "d2", text: "hello", deliverAs: "followUp" };

		expect(await rpc.send(record)).toMatchObject({ success: true, data: { kind: "started" } });
		expect(await rpc.send(record)).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		await fixture.session.waitForIdle();

		expect(deliveries()).toHaveLength(1);
	});

	it("answers already_admitted for an id the transcript already holds after the session is reopened from its file", async () => {
		// Given: a delivery written to the transcript by one process.
		const { fixture, rpc } = await setup();
		const record = { type: "admit_external_message", deliveryId: "d6", text: "once", deliverAs: "followUp" };
		expect(await rpc.send(record)).toMatchObject({ success: true, data: { kind: "started" } });

		// When: the session is reopened from its file (a fresh ledger) and the same id arrives again.
		const reopened = await fixture.reopen();
		const again = await reopened.send(record);

		// Then: the transcript answers for the lost ledger and nothing is written twice.
		expect(again).toMatchObject({ success: true, data: { kind: "already_admitted" } });
		const written = fixture.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === SESSION_CONTROL_DELIVERY_TYPE);
		expect(written).toHaveLength(1);
	});

	it("runs the thread-chain guard first and records the admitted hop on the delivery", async () => {
		const { fixture, rpc, deliveries } = await setup({ settings: { threads: { chainCountLimit: 2 } } });
		const base = { type: "admit_external_message", text: "hop", deliverAs: "followUp", whenIdle: "queue" };

		const refused = await rpc.send({ ...base, deliveryId: "d7", chainCount: 3 });
		expect(refused).toMatchObject({ success: false, errorCode: CHAIN_COUNT_LIMIT });
		expect(fixture.session.externalAdmission.list().pending).toEqual([]);

		expect(await rpc.send({ ...base, deliveryId: "d8", chainCount: 2 })).toMatchObject({
			success: true,
			data: { kind: "queued" },
		});
		await rpc.send({ type: "prompt", message: "go" });
		await fixture.session.waitForIdle();
		expect(deliveries()).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ delivery_id: "rpc:local/d8", chain_count: 2 }) }),
		]);
	});

	it("answers turn_conflict for a stale expectedTurnId and admits nothing", async () => {
		const { fixture, rpc, deliveries } = await setup();

		const reply = await rpc.send({
			type: "admit_external_message",
			deliveryId: "d3",
			text: "late",
			deliverAs: "steer",
			expectedTurnId: "99",
		});

		expect(reply).toMatchObject({ success: true, data: { kind: "turn_conflict", turnId: "0" } });
		expect(fixture.session.pendingMessageCount).toBe(0);
		expect(deliveries()).toEqual([]);
	});

	it("queues a follow-up and steers the running turn it names, without the input event", async () => {
		// Given: a session mid-turn.
		const { fixture, rpc, inputs, entered, release } = await setup({ hold: true });
		await rpc.send({ type: "prompt", message: "hold" });
		await entered.promise;
		try {
			const turnId = ((await rpc.send({ type: "get_state" })).data as { currentTurnId?: string }).currentTurnId;

			// When: a follow-up and a steer naming the running turn arrive.
			const followUp = await rpc.send({
				type: "admit_external_message",
				deliveryId: "d4",
				text: "after this",
				deliverAs: "followUp",
			});
			const steer = await rpc.send({
				type: "admit_external_message",
				deliveryId: "d5",
				text: "change course",
				deliverAs: "steer",
				expectedTurnId: turnId,
			});

			// Then: both are held by the runtime's queues and only the user's own prompt fired the input event.
			expect(followUp).toMatchObject({ success: true, data: { kind: "queued", turnId } });
			expect(steer).toMatchObject({ success: true, data: { kind: "steered", turnId } });
			expect([...fixture.session.externalAdmission.list().pending].sort()).toEqual(["rpc:local/d4", "rpc:local/d5"]);
			expect(inputs).toEqual(["hold"]);
		} finally {
			release();
		}
		await Promise.all(rpc.handler.pendingPrompts());
	});

	it.each([
		{ type: "admit_external_message", text: "x", deliverAs: "followUp" },
		{ type: "admit_external_message", deliveryId: "", text: "x", deliverAs: "followUp" },
		{ type: "admit_external_message", deliveryId: "d", text: "", deliverAs: "followUp" },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "nextTurn" },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", expectedTurnId: 3 },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", expectedTurnId: "" },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", chainCount: 0 },
		{
			type: "admit_external_message",
			deliveryId: "d",
			text: "x",
			deliverAs: "steer",
			remote_origin: { deviceId: "forged" },
		},
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", whenIdle: "later" },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", displayText: 7 },
		{ type: "admit_external_message", deliveryId: "d", text: "x", deliverAs: "steer", sender: { kind: "user" } },
		{
			type: "admit_external_message",
			deliveryId: "d",
			text: "x",
			deliverAs: "steer",
			sender: { kind: "agent", session_id: "s", role: "user" },
		},
	])("refuses a malformed record on both validators: %j", (record) => {
		expect(rpcCommandPayloadError(record)).toMatch(/^admit_external_message /);
		expect(validateRpcInboundRecord(record)).toMatchObject({ ok: false });
	});

	it("accepts a well-formed record from a validated caller and classes it drive, even a /-led text", () => {
		const record = {
			type: "admit_external_message",
			sessionId: "s",
			deliveryId: "d",
			text: "/mcp add evil",
			sender: { kind: "external", platform: "relay", author: "a" },
			displayText: "hi",
			deliverAs: "steer",
			expectedTurnId: "3",
			whenIdle: "queue",
			chainCount: 2,
		};
		expect(validateRpcInboundRecord(record)).toEqual({ ok: true });
		expect(classifyRpcMethod(record)).toBe("drive");
	});
});
