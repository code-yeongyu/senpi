import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { expect, it } from "vitest";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

it.each(["new_session", "switch_session", "fork", "clone"])(
	"%s announces the previous and current durable identities to both attached clients",
	async (type) => {
		await using host = await statusHost();
		const owner = host.client("owner");
		const observer = host.client("observer");
		host.faux.setResponses([fauxAssistantMessage("persisted")]);
		const open = async () =>
			String(
				dataOf(
					await owner.request({
						type: "open_session",
						cwd: host.cwd,
						provider: host.model.provider,
						modelId: host.model.id,
					}),
				).sessionId,
			);
		const sessionId = await open();
		const idle = owner.waitFor((r) => r.type === "agent_idle" && r.sessionId === sessionId);
		dataOf(await owner.request({ type: "prompt", sessionId, message: "saved input" }));
		await idle;
		const current = dataOf(await owner.request({ type: "get_state", sessionId }));
		dataOf(await observer.request({ type: "attach_session", sessionId, durableSessionId: current.sessionId }));
		const before = dataOf(await observer.request({ type: "get_state", sessionId }));
		const command: Record<string, unknown> = { type, sessionId };
		if (type === "fork") {
			const { messages } = dataOf(await owner.request({ type: "get_fork_messages", sessionId }));
			if (!Array.isArray(messages) || !messages[0]?.entryId) throw new Error("missing fork entry");
			command.entryId = messages[0].entryId;
		}
		if (type === "switch_session") {
			const target = await open();
			const targetIdle = owner.waitFor((r) => r.type === "agent_idle" && r.sessionId === target);
			host.faux.setResponses([fauxAssistantMessage("target")]);
			dataOf(await owner.request({ type: "prompt", sessionId: target, message: "target input" }));
			await targetIdle;
			command.sessionPath = dataOf(await owner.request({ type: "get_state", sessionId: target })).sessionFile;
			dataOf(await owner.request({ type: "close_session", sessionId: target }));
		}
		const events = [owner, observer].map((c) =>
			c.waitFor((r) => r.type === "session_replaced" && r.sessionId === sessionId),
		);
		dataOf(await owner.request(command));
		const after = dataOf(await observer.request({ type: "get_state", sessionId }));
		expect(before.sessionId).not.toBe(after.sessionId);
		for (const event of await Promise.all(events)) {
			expect(event).toMatchObject({
				replacedSessionId: before.sessionId,
				replacedSessionFile: before.sessionFile,
				durableSessionId: after.sessionId,
			});
		}
	},
	60_000,
);
