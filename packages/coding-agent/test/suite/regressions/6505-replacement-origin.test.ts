import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createHarness, type Harness } from "../harness.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

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
);

it("an in-memory fork, which reuses the outgoing session's manager, still announces the outgoing identity", async () => {
	const [first, second] = await Promise.all([createHarness(), createHarness()]);
	harnesses.push(first, second);
	let live: AgentSession = first.session;
	let rebind: (() => Promise<void>) | undefined;
	const runtimeHost = {
		get session() {
			return live;
		},
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn((callback?: () => Promise<void>) => {
			rebind = callback;
		}),
	} as unknown as AgentSessionRuntime;
	const records: Record<string, unknown>[] = [];
	const handler = createRpcConnectionHandler(
		runtimeHost,
		{
			writeRaw: (chunk) => {
				for (const line of chunk.split("\n")) if (line) records.push(JSON.parse(line) as Record<string, unknown>);
			},
			waitForBackpressure: async () => {},
		},
		{ sessionId: "rpc-attached" },
	);
	await handler.ready;
	const outgoing = { id: first.session.sessionId, file: first.session.sessionFile };

	// What AgentSessionRuntime.fork does in memory: the outgoing session's manager starts the new session in
	// place, so the outgoing AgentSession now reads the new id, before the runtime rebinds the connection.
	first.session.sessionManager.newSession({ parentSession: outgoing.file });
	live = second.session;
	await rebind?.();

	expect(first.session.sessionId).not.toBe(outgoing.id);
	const events = records.filter((record) => record.type === "session_replaced");
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ replacedSessionId: outgoing.id, durableSessionId: second.session.sessionId });
	expect(events[0].replacedSessionFile).toBe(outgoing.file);
	await handler.dispose();
});
