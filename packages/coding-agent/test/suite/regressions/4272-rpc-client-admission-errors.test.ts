import { afterEach, expect, it, vi } from "vitest";
import { RpcClientAdmissions } from "../../../src/modes/rpc/rpc-client-admissions.ts";
import { admissionClient } from "./4272-rpc-client-admission-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it("does not inspect an incoming frame when no compact routes exist", () => {
	const client = new RpcClientAdmissions(async () => ({
		type: "response",
		command: "close_session",
		success: true,
		data: {},
	}));
	const read = vi.fn(() => "session");
	client.receive(Object.defineProperty({}, "sessionId", { get: read }));
	expect(read).not.toHaveBeenCalled();
});

it("turns a page refusal without errorData into RpcCommandError", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client } = fixture;
	await client.openSession({ cwd: host.cwd, admissionId: "refused" });
	vi.spyOn(host.core.router, "handle").mockImplementationOnce(async (command) => ({
		id: command.id,
		type: "response",
		command: "get_recovery_page",
		success: false,
		error: "page refused",
		errorCode: "page_refused",
	}));
	await expect(client.admissions.page("refused", "manifest")).rejects.toMatchObject({
		name: "RpcCommandError",
		errorCode: "page_refused",
	});
}, 120_000);

it("open returns the repaired identity if its initial manifest requires a restart", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client, requests } = fixture;
	const handle = host.core.router.handle.bind(host.core.router);
	let firstPage = true;
	vi.spyOn(host.core.router, "handle").mockImplementation((command) => {
		if (command.type === "get_recovery_page" && firstPage) {
			firstPage = false;
			for (const token of host.writer.recoveryCheckpoints.tokens()) host.writer.recoveryCheckpoints.release(token);
		}
		return handle(command);
	});
	const opened = await client.openSession({ cwd: host.cwd, admissionId: "restart-open" });
	const stream = host.writer.recoveryCheckpoints.stream({
		socketEpoch: host.writer.socketEpochOf("rpc-client") ?? "",
		sessionId: opened.sessionId,
	});
	expect(requests.filter((request) => request.type === "reset_stream")).toHaveLength(1);
	expect(opened).toMatchObject({ generation: stream?.generation });
	expect(opened).toMatchObject({ generation: 2 });
}, 120_000);

it("RULING-92 logs and drops unmatched responses instead of delivering them as events", async () => {
	await using fixture = await admissionClient();
	const { host, client } = fixture;
	const events = vi.fn();
	client.onEvent(events);
	const log = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	await host.writer.enqueueControl(
		{ type: "response", id: "not-pending", command: "close_session", success: true, data: {} },
		"rpc-client",
	);
	// The next real response on this FIFO is the dispatch barrier, not a timing delay.
	await client.openSession({ cwd: host.cwd });
	expect(events.mock.calls.map(([event]) => event)).not.toContainEqual(expect.objectContaining({ type: "response" }));
	expect(log).toHaveBeenCalledTimes(1);
}, 120_000);

it("a matched page response advances the generation fence before a stale event is read", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client, requests } = fixture;
	const opened = await client.openSession({ cwd: host.cwd, admissionId: "fence" });
	const handle = host.core.router.handle.bind(host.core.router);
	vi.spyOn(host.core.router, "handle").mockImplementationOnce(async (command) => {
		const response = (await handle(command)) ?? expect.unreachable();
		return { ...response, sessionId: opened.sessionId, admissionId: "fence", generation: 7 };
	});
	expect((await client.admissions.page("fence", "manifest")).action).toBe("ready");
	await host.writer.enqueueControl(
		{ type: "agent_idle", sessionId: "stale-session", admissionId: "fence", generation: 6 },
		"rpc-client",
	);
	await client.getState();
	expect((await client.admissions.page("fence", "manifest")).action).toBe("ready");
	expect(requests.filter((request) => request.type === "get_recovery_page").at(-1)?.sessionId).toBe(opened.sessionId);
}, 120_000);
