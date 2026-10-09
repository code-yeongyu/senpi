/**
 * A delivery whose transcript entry the session file refuses (a real `chmod 0444`, so EACCES), on a REAL
 * in-process host (real `AgentSession`, real extension drain, real admission ledger): the delivery is
 * settled as failed with the error instead of staying `pending` forever, so it no longer counts as a held
 * start; the next delivery starts its own turn and reaches disk once the file is writable; and the failed
 * one is admitted again only after the file has taken a later entry, so it is redelivered rather than lost.
 */
import { chmodSync, readFileSync } from "node:fs";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { gatewayFixture } from "./rpc-release-gateway-fixture.ts";
import { nextEvent, startReleaseHost } from "./rpc-release-host-support.ts";

const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!unprivileged)("a delivery whose entry the session file refuses", () => {
	it("is settled as failed, does not hold later deliveries, and is redelivered once the file takes writes", async () => {
		// Given: a quiet session whose file refuses writes.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([
			fauxAssistantMessage("seed reply"),
			fauxAssistantMessage("refused reply"),
			fauxAssistantMessage("ok reply"),
			fauxAssistantMessage("redelivered reply"),
		]);
		const { sessionId, sessionPath, session } = await host.open("refused-delivery");
		chmodSync(sessionPath, 0o444);

		// When: a delivery starts a turn whose entries the file refuses.
		let settled = nextEvent(session, "agent_settled");
		const refused = await host.send({ type: "wake", id: "w1", sessionId, delivery_ids: ["refused-1"] });
		await settled;
		chmodSync(sessionPath, 0o644);

		// Then: it is not held; it is failed with the write error.
		expect(refused).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "started" }] } });
		const afterRefusal = session.externalAdmission.list();
		expect(afterRefusal).toMatchObject({ pending: [], emitted: [], failed: [{ delivery_id: "refused-1" }] });
		expect(afterRefusal.failed?.[0]?.error).toMatch(/^EACCES/);

		// When: the next delivery arrives with the file writable again.
		settled = nextEvent(session, "agent_settled");
		const next = await host.send({ type: "wake", id: "w2", sessionId, delivery_ids: ["ok-1"] });

		// Then: it starts its own turn and reaches disk, which makes the refused one admissible again.
		expect(next).toMatchObject({ data: { admitted: [{ delivery_id: "ok-1", kind: "started" }] } });
		await settled;
		expect(readFileSync(sessionPath, "utf8")).toContain("DELIVERY ok-1");
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: ["ok-1"] });

		// When: the sender redelivers the refused one.
		settled = nextEvent(session, "agent_settled");
		const redelivered = await host.send({ type: "wake", id: "w3", sessionId, delivery_ids: ["refused-1"] });

		// Then: it is admitted, written once, and emitted.
		expect(redelivered).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "started" }] } });
		await settled;
		const text = readFileSync(sessionPath, "utf8");
		expect(text.split("DELIVERY refused-1").length - 1).toBe(1);
		expect(session.externalAdmission.list()).toEqual({ pending: [], emitted: ["ok-1", "refused-1"] });
	});

	it("is not redelivered inside the run that refused it when the file recovers mid-run: one copy in context and on disk", async () => {
		// Given: a session whose file refuses the delivery entry, then takes the same run's next assistant message.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		const contextCopies: number[] = [];
		const copiesIn = (context: unknown): number => JSON.stringify(context).split("DELIVERY refused-1").length - 1;
		let redeliverMidRun: () => Promise<unknown> = async () => undefined;
		let firstAssistantWritten: Promise<void> = Promise.resolve();
		let midRunWake: unknown;
		const answer =
			(text: string): FauxResponseStep =>
			(context) => {
				contextCopies.push(copiesIn(context));
				return fauxAssistantMessage(text);
			};
		host.faux.setResponses([
			fauxAssistantMessage("seed reply"),
			(context) => {
				contextCopies.push(copiesIn(context));
				return fauxAssistantMessage([fauxToolCall("no_such_tool", {})], { stopReason: "toolUse" });
			},
			async (context) => {
				contextCopies.push(copiesIn(context));
				await firstAssistantWritten;
				midRunWake = await redeliverMidRun();
				return fauxAssistantMessage("refused run reply");
			},
			answer("redelivered reply"),
			answer("spare reply"),
		]);
		const { sessionId, sessionPath, session } = await host.open("midrun-recovery");
		const manager = session.sessionManager;
		// AgentSession persists its own turn messages through appendOwnedMessage (senpi#2537).
		const appendOwnedMessage = manager.appendOwnedMessage.bind(manager);
		let assistantWritten!: () => void;
		firstAssistantWritten = new Promise((resolve) => {
			assistantWritten = resolve;
		});
		manager.appendOwnedMessage = (message) => {
			const id = appendOwnedMessage(message);
			if (message.role === "assistant") assistantWritten();
			return id;
		};
		session.subscribe((event) => {
			if (event.type === "transcript_write_failed" && event.role === "custom") chmodSync(sessionPath, 0o644);
		});
		redeliverMidRun = () => host.send({ type: "wake", id: "w2", sessionId, delivery_ids: ["refused-1"] }, "mid-run");
		chmodSync(sessionPath, 0o444);

		// When: the delivery runs, the sender retries it inside that run, and again after the run settled.
		let settled = nextEvent(session, "agent_settled");
		await host.send({ type: "wake", id: "w1", sessionId, delivery_ids: ["refused-1"] });
		await settled;
		settled = nextEvent(session, "agent_settled");
		const afterSettle = await host.send({ type: "wake", id: "w3", sessionId, delivery_ids: ["refused-1"] });
		const kindOf = (reply: unknown): unknown =>
			(reply as { data?: { admitted?: { kind?: string }[] } }).data?.admitted?.[0]?.kind;
		if (kindOf(afterSettle) === "started") await settled;

		// Then: refused inside its own run, redelivered once after it, and held once in context and on disk.
		expect({
			midRun: kindOf(midRunWake),
			afterSettle: kindOf(afterSettle),
			mostCopiesInContext: Math.max(...contextCopies),
			onDisk: readFileSync(sessionPath, "utf8").split("DELIVERY refused-1").length - 1,
			ledger: session.externalAdmission.list(),
		}).toEqual({
			midRun: "already_admitted",
			afterSettle: "started",
			mostCopiesInContext: 1,
			onDisk: 1,
			ledger: { pending: [], emitted: ["refused-1"] },
		});
	});

	it("answers already_admitted for a failed delivery while the file has taken no later entry", async () => {
		// Given: a delivery the file refused, and a file that still refuses writes.
		const gateway = gatewayFixture();
		await using host = await startReleaseHost(gateway.extension);
		host.faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("refused reply")]);
		const { sessionId, sessionPath, session } = await host.open("refused-loop");
		chmodSync(sessionPath, 0o444);
		const settled = nextEvent(session, "agent_settled");
		await host.send({ type: "wake", id: "w1", sessionId, delivery_ids: ["refused-1"] });
		await settled;

		// When: a wake names it again before anything was written.
		const again = await host.send({ type: "wake", id: "w2", sessionId, delivery_ids: ["refused-1"] });
		chmodSync(sessionPath, 0o644);

		// Then: no second turn runs against a file that refuses it; the delivery stays failed.
		expect(again).toMatchObject({ data: { admitted: [{ delivery_id: "refused-1", kind: "already_admitted" }] } });
		expect(session.externalAdmission.list()).toMatchObject({ pending: [], failed: [{ delivery_id: "refused-1" }] });
	});
});
