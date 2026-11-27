import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { startHost } from "../suite/rpc-delegated-host-support.ts";

it("answers a pending id's own position, including on replay, without exposing private hold fields", async () => {
	const host = await startHost();
	try {
		const manager = SessionManager.create(host.cwd, host.scratch);
		manager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		manager.appendMessage(fauxAssistantMessage("seeded"));
		const since = "2026-11-27T00:00:00.000Z";
		manager.appendCustomEntry("session-hold", {
			op: "add",
			kind: "session_hold",
			key: "interrupted-run",
			data: "private",
			pauseSeq: 1,
			at: since,
		});
		const peer = await host.proven();
		const opened = await peer.send({ type: "open_session", sessionPath: manager.getSessionFile(), attended: false });
		expect(opened.success).toBe(true);
		const sessionId = (opened.data as { sessionId: string }).sessionId;
		const receipts = [];
		for (const n of [1, 2, 1]) {
			const response = await peer.send({
				type: "admit_external_message",
				sessionId,
				deliveryId: `peer-${n}`,
				text: `${n}`,
				deliverAs: "followUp",
				sender: { kind: "agent", session_id: "sender" },
			});
			expect(response.success).toBe(true);
			receipts.push(response.data);
		}
		const hold = { kind: "session_hold", key: "interrupted-run", since };
		expect(receipts).toMatchObject([
			{ kind: "held", queuePosition: 1, hold: { ...hold, queueDepth: 1 } },
			{ kind: "held", queuePosition: 2, hold: { ...hold, queueDepth: 2 } },
			{ kind: "already_admitted", queuePosition: 1, hold: { ...hold, queueDepth: 2 } },
		]);
		expect(JSON.stringify(receipts)).not.toContain("private");
		expect((await peer.send({ type: "get_protocol_info" })).data).toMatchObject({
			capabilities: expect.arrayContaining(["external_admission_position"]),
		});
	} finally {
		await host.dispose();
	}
});
