/**
 * `release_session` against gateway deliveries, on a REAL in-process host (real `AgentSession`, real
 * extension drain, real admission ledger and agent queues): a drain pass still running when the
 * release decides admits nothing after the claim, so nothing follows `session_released` and the
 * delivery stays with its sender; `interrupt` takes queued deliveries and queued user text out of the
 * session and hands both back in `dropped`, so neither vanishes nor lands on disk.
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { RELEASE_QUEUED_HINT, RELEASED_ADMISSION_CLOSED } from "../../src/modes/rpc/session-release.ts";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { afterReleased, heldTurn, nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

describe("release_session and gateway deliveries (real host)", () => {
	it("a drain pass that admits during the teardown is refused: nothing follows session_released", async () => {
		// Given: a quiet, detached session whose drain pass is mid-flight (woken, not yet admitting).
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("late reply")]);
		const { sessionId, sessionPath, session } = await host.open("late-drain");
		const late = gateway.armLateDrain();
		late.wake();
		await late.entered;

		// When: the release decides and claims, and only then does the drain try to admit.
		const reply = host.release(sessionId);
		late.go();

		// Then: released; the admission was refused; no delivery entry, reply or anything else after the release.
		expect(await reply).toMatchObject({ success: true, data: { released: true } });
		expect(gateway.outcomes).toEqual([`late-1:refused:${RELEASED_ADMISSION_CLOSED}`]);
		expect(afterReleased(sessionPath)).toEqual([]);
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: [] });
	});

	it("interrupt drops a queued delivery out of the session, releases, and reports it for redelivery", async () => {
		// Given: a turn running and a delivery admitted into its follow-up queue.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-delivery");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["q-1"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "q-1", kind: "queued" }] },
		});

		// When: the release interrupts.
		const reply = await host.release(sessionId, { interrupt: true });

		// Then: released, the delivery reported as dropped, never written, and nothing after session_released.
		expect(reply).toMatchObject({
			success: true,
			data: { released: true, dropped: { deliveries: ["q-1"], user_messages: [] } },
		});
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: [] });
		expect(readFileSync(sessionPath, "utf8")).not.toContain("DELIVERY q-1");
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("interrupt hands the user's queued steer and follow-up text back instead of dropping it silently", async () => {
		// Given: a turn running with user text queued behind it.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-user");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "steer", id: "s", sessionId, message: "USER STEER TEXT" });
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });

		// When: the release interrupts.
		const reply = await host.release(sessionId, { interrupt: true });

		// Then: both texts come back in enqueue order, neither is on disk, nothing follows the release.
		expect(reply).toMatchObject({
			success: true,
			data: { released: true, dropped: { deliveries: [], user_messages: ["USER STEER TEXT", "USER FOLLOW TEXT"] } },
		});
		// The texts were handed back, so none is stored as a message, and the durable admission records
		// that kept them while queued are closed (newest state not "queued"), so a reopen restores neither.
		const entries = readFileSync(sessionPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map(
				(line) =>
					JSON.parse(line) as {
						type: string;
						customType?: string;
						data?: Record<string, unknown>;
						message?: unknown;
					},
			);
		const messages = entries
			.filter((entry) => entry.type === "message")
			.map((entry) => JSON.stringify(entry.message));
		expect(
			messages.filter((message) => message.includes("USER STEER TEXT") || message.includes("USER FOLLOW TEXT")),
		).toEqual([]);
		const newest = new Map<string, unknown>();
		for (const entry of entries)
			if (entry.customType === "rpc_client_message_admission")
				newest.set(String(entry.data?.clientMessageId), entry.data?.state);
		expect([...newest.values()].filter((state) => state === "queued")).toEqual([]);
		expect(afterReleased(sessionPath)).toEqual([]);
	});

	it("after an interrupt, the session journal and the RPC ledger agree on every identified input it handed back", async () => {
		// Given: a turn running with identified user input queued behind it (senpi#3549 review M1).
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, sessionPath, session } = await host.open("queued-identified");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "steer", id: "s", sessionId, message: "ID STEER", clientMessageId: "c-steer" });
		await host.send({ type: "follow_up", id: "f", sessionId, message: "ID FOLLOW", clientMessageId: "c-follow" });

		// When: the release interrupts.
		await host.release(sessionId, { interrupt: true });

		// Then: both durable records read the same: neither input is still queued in either, so a reopen
		// restores neither and no status reports one as waiting.
		const entries = readFileSync(sessionPath, "utf8")
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as { customType?: string; data?: Record<string, unknown> });
		const ledger = new Map<string, unknown>();
		const journal = new Map<string, unknown>();
		for (const entry of entries) {
			if (entry.customType === "rpc_client_message_admission")
				ledger.set(String(entry.data?.clientMessageId), entry.data?.state);
			if (entry.customType === "pending_input_transition") {
				type Recorded = { clientMessageId?: string; phase?: string };
				const inputs = [entry.data?.input, ...((entry.data?.batch as Recorded[] | undefined) ?? [])] as Recorded[];
				for (const input of inputs) journal.set(String(input?.clientMessageId), input?.phase);
			}
		}
		expect(Object.fromEntries(ledger)).toEqual({ "c-steer": "completed", "c-follow": "completed" });
		expect(Object.fromEntries(journal)).toEqual({ "c-steer": "removed", "c-follow": "removed" });
	});

	it("an interrupted release refused `attached` reopens admission and still hands back what it took", async () => {
		// Given: a running turn, user text queued behind it, and a prompt held in its input handler, which
		// keeps the interrupt's settle window open.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([
			fauxAssistantMessage("seed reply"),
			heldTurn,
			fauxAssistantMessage("after 1"),
			fauxAssistantMessage("after 2"),
			fauxAssistantMessage("after 3"),
		]);
		const { sessionId, sessionPath, session } = await host.open("attached-refusal");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });
		const input = gateway.holdNextInput();
		void host.send(
			{ type: "prompt", id: "slow", sessionId, message: "slow input", streamingBehavior: "followUp" },
			"held-input",
		);
		await input.entered;

		// When: the release interrupts, and a client attaches while it waits for the held prompt.
		const aborted = nextEvent(session, "agent_end");
		const reply = host.release(sessionId, { interrupt: true });
		await aborted;
		expect(await host.attach(sessionPath)).toMatchObject({ success: true, data: { attached: true } });
		input.go();

		// Then: refused with what the interrupt took, and the session the host keeps admits deliveries again.
		expect(await reply).toMatchObject({
			success: false,
			error: "attached",
			errorData: {
				attachments: 1,
				interrupted: true,
				dropped: { deliveries: [], user_messages: ["USER FOLLOW TEXT"] },
			},
		});
		expect(await host.send({ type: "wake", id: "w", sessionId, delivery_ids: ["after-refusal"] })).toMatchObject({
			success: true,
			data: { admitted: [{ delivery_id: "after-refusal" }] },
		});
		expect(gateway.outcomes.filter((outcome) => outcome.includes(":refused:"))).toEqual([]);
	});

	it("a plain release with the user's text queued names interrupt as the way to recover it", async () => {
		// Given: a turn running with user text queued behind it.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), heldTurn]);
		const { sessionId, session } = await host.open("queued-plain");
		const started = nextEvent(session, "agent_start");
		await host.send({ type: "prompt", id: "work", sessionId, message: "long work" });
		await started;
		await host.send({ type: "follow_up", id: "f", sessionId, message: "USER FOLLOW TEXT" });

		// When: a plain release, then the one it points to.
		const plain = await host.release(sessionId);
		const interrupted = await host.release(sessionId, { interrupt: true });

		// Then: the refusal says interrupt recovers the text, and the interrupt does.
		expect(plain).toMatchObject({
			success: false,
			error: "turn_active",
			errorData: {
				busy: expect.arrayContaining(["queued"]),
				retry_with: { interrupt: true },
				hint: RELEASE_QUEUED_HINT,
			},
		});
		expect(interrupted).toMatchObject({
			success: true,
			data: { released: true, dropped: { user_messages: ["USER FOLLOW TEXT"] } },
		});
	});
});
