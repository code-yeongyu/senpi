import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

// senpi#4272 S03b-3b persistence status: the transcript join drives each settled message's compact persistence,
// ordered after acceptance: an owned append marks it appended, a transcript_write_failed record marks it failed.
it("the real transcript join moves compact persistence from pending to appended or failed", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("persistence");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const session = entry?.runtime?.session;
	if (!lane || !session) throw new Error("no real lane");
	const prompt = async (message: string, answer: string) => {
		host.faux.setResponses([fauxAssistantMessage(answer, { timestamp: 1 })]);
		const idle = (record: { type?: unknown }) => record.type === "agent_idle";
		const seen = client.inbox.filter(idle).length;
		const done = client.waitFor((record) => idle(record) && client.inbox.filter(idle).length > seen, 15_000);
		dataOf(await client.request({ type: "prompt", sessionId, message }));
		await done;
		await host.writer.flush();
	};
	await prompt("first", "persisted answer");
	const append = session.sessionManager.appendOwnedMessage.bind(session.sessionManager);
	const refuse = vi.spyOn(session.sessionManager, "appendOwnedMessage").mockImplementation((message, options) => {
		if (message.role === "assistant") throw new Error("EACCES: injected transcript failure");
		return append(message, options);
	});
	await prompt("second", "refused answer");
	refuse.mockRestore();
	// A record after the second run carries its last journaled transitions into the lane.
	await prompt("third", "after the failure");
	await lane.idle();
	const root = lane.freeze();
	try {
		const { messages } = await lane.readCurrent(root);
		const status = (role: string, text: string) =>
			messages.find(
				(message) =>
					message.message?.role === role && JSON.stringify(message.message.content).includes(`"${text}"`),
			)?.persistence;
		const seen = JSON.stringify(messages.map((message) => [message.message ?? message.blocks, message.persistence]));
		expect(status("assistant", "persisted answer"), seen).toBe("appended");
		expect(status("assistant", "refused answer"), seen).toBe("failed");
		expect(status("assistant", "after the failure"), seen).toBe("appended");
		for (const text of ["first", "second", "third"]) expect(status("user", text), seen).toBe("appended");
	} finally {
		lane.release(root);
	}
}, 90_000);
