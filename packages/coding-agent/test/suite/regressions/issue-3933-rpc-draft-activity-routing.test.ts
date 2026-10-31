import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeResult } from "../../../src/core/agent-session-runtime.ts";
import { RPC_ERROR_INVALID_ARGUMENT, type RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHarness, type Harness } from "../harness.ts";
import { makeSink } from "../rpc-connection-harness.ts";

const harnesses: Harness[] = [];
const routers: SessionCommandRouter[] = [];
let requestId = 0;

afterEach(async () => {
	for (const router of routers.splice(0)) await router.dispose();
	for (const harness of harnesses.splice(0)) harness.cleanup();
	vi.restoreAllMocks();
});

async function twoSessionHost() {
	const sessions: Harness[] = [];
	for (let index = 0; index < 2; index++) {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		sessions.push(harness);
	}
	const sink = makeSink();
	const registry = new RpcSessionRegistry({
		agentDir: `${sessions[0].tempDir}/host`,
		createRuntime: async ({ cwd, agentDir }) => {
			const harness = sessions.find((candidate) => candidate.tempDir === cwd);
			if (!harness) throw new Error("unexpected session cwd");
			return {
				session: harness.session,
				diagnostics: [],
				services: { cwd, agentDir },
			} as unknown as CreateAgentSessionRuntimeResult;
		},
	});
	const writer = new SessionEventWriter(sink.sink.writeRaw, (flush) => flush());
	const router = new SessionCommandRouter(registry, writer, { cwd: sessions[0].tempDir });
	routers.push(router);
	const send = async (command: RpcCommand & { id: string }) => {
		const response = sink.waitFor((record) => record.type === "response" && record.id === command.id);
		const direct = await router.handle(command);
		if (direct) sink.sink.writeRaw(`${JSON.stringify(direct)}\n`);
		await writer.flush();
		return response;
	};
	const handles: string[] = [];
	for (const harness of sessions) {
		const opened = await send({ id: `open-${++requestId}`, type: "open_session", cwd: harness.tempDir });
		expect(opened.success).toBe(true);
		if (typeof opened.sessionId !== "string") throw new Error("missing routing handle");
		handles.push(opened.sessionId);
	}
	expect(handles[0]).not.toBe(handles[1]);
	const activity = sessions.map((harness) => vi.spyOn(harness.session, "recordUserActivity"));
	return { handles, activity, send };
}

describe("record_user_activity on a multi-session host (#3933)", () => {
	it("records the draft on the addressed session only", async () => {
		const host = await twoSessionHost();

		const response = await host.send({
			id: `draft-${++requestId}`,
			type: "record_user_activity",
			sessionId: host.handles[1],
			kind: "draft",
		});

		expect(response).toMatchObject({ command: "record_user_activity", success: true, sessionId: host.handles[1] });
		expect(host.activity[1]).toHaveBeenCalledTimes(1);
		expect(host.activity[1]).toHaveBeenCalledWith("draft");
		expect(host.activity[0]).not.toHaveBeenCalled();
	});

	it("refuses another kind with a fixed message that does not echo the client value", async () => {
		const host = await twoSessionHost();
		const hostile = "<script>alert(1)</script>";

		const response = await host.send({
			id: `bad-${++requestId}`,
			type: "record_user_activity",
			sessionId: host.handles[0],
			kind: hostile,
		} as unknown as RpcCommand & { id: string });

		expect(response).toMatchObject({
			command: "record_user_activity",
			success: false,
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
			error: 'record_user_activity: kind must be "draft"',
		});
		expect(String(response.error)).not.toContain(hostile);
		expect(host.activity[0]).not.toHaveBeenCalled();
		expect(host.activity[1]).not.toHaveBeenCalled();
	});
});
