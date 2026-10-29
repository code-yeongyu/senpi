import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { RpcClient } from "../../../src/modes/rpc/rpc-client.ts";
import type { CompactOpenResult, LegacyOpenResult } from "../../../src/modes/rpc/rpc-client-admissions.ts";
import { storageUnavailable } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { admissionClient } from "./4272-rpc-client-admission-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it("T2 dynamically selected admission options expose both possible open result shapes", () => {
	expectTypeOf<ReturnType<RpcClient["openSession"]>>().toEqualTypeOf<Promise<LegacyOpenResult | CompactOpenResult>>();
});

// #4272 RULING-84 blocking carry: real RpcClient/socket/parser/router/page owner,
// not a test-side policy invocation. Only the storage failure and Date are controlled.
it("the in-repo client honours the hint end to end", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client, requests } = fixture;
	const options = { cwd: host.cwd, admissionId: "client-repair" };
	const opened = await client.openSession(options);
	expect(requests.map((request) => request.type)).toContain("get_recovery_page");
	const lane = host.writer.recoveryLane(opened.sessionId);
	if (!lane) throw new Error("missing real acceptance lane");
	vi.useFakeTimers({ toFake: ["Date"], now: 10_000 });
	const read = vi.spyOn(host.writer.recoveryCheckpoints, "readCatalogPage");
	read.mockImplementationOnce(async () => {
		// Transport/storage time is not part of the server's new backoff: observe at receive, not send.
		vi.setSystemTime(12_001);
		lane.staging.store.health.unavailable();
		return { ok: false, failure: storageUnavailable("unavailable") };
	});
	const resets = () => requests.filter((request) => request.type === "reset_stream").length;
	const first = await client.admissions.page("client-repair", "manifest");
	expect(first.action).toBe("wait");
	expect(resets()).toBe(0);
	const afterFailure = requests.length;
	expect((await client.admissions.page("client-repair", "manifest")).action).toBe("wait");
	expect(requests).toHaveLength(afterFailure);
	vi.setSystemTime(20_000);
	read.mockImplementationOnce(async () => ({ ok: false, failure: storageUnavailable("unavailable") }));
	expect((await client.admissions.page("client-repair", "manifest")).action).toBe("wait");
	expect(resets()).toBe(0);
	await lane.staging.store.repair();
	vi.setSystemTime(30_000);
	expect((await client.admissions.page("client-repair", "manifest")).action).toBe("restart_from_catalog");
	expect(resets()).toBe(1);
	expect((await client.admissions.page("client-repair", "manifest")).action).toBe("ready");
	expect(requests.some((request) => ["prompt", "get_entries", "get_state"].includes(String(request.type)))).toBe(
		false,
	);
	expect(requests.filter((request) => request.type === "open_session")).toHaveLength(1);
	expect(fixture.failures).toEqual([]);
}, 120_000);

it("T2/T5 an identical client retry keeps the repaired generation and a conflicting retry cannot erase it", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using fixture = await admissionClient();
	const { host, client, requests } = fixture;
	const options = { cwd: host.cwd, admissionId: "client-retry" };
	const opened = await client.openSession(options);
	const token = host.writer.recoveryCheckpoints.tokens()[0] ?? expect.unreachable();
	host.writer.recoveryCheckpoints.release(token);
	expect((await client.admissions.page("client-retry", "manifest")).action).toBe("restart_from_catalog");
	expect((await client.admissions.page("client-retry", "manifest")).action).toBe("ready");
	const retried = await client.openSession(options);
	expect(retried).toMatchObject({ generation: 2 });
	expect(retried).toMatchObject({
		recovery: { token: host.writer.recoveryCheckpoints.tokens()[0]?.id },
	});
	expect(requests.filter((request) => request.type === "reset_stream")).toHaveLength(1);
	expect(
		host.writer.recoveryCheckpoints.stream({
			socketEpoch: host.writer.socketEpochOf("rpc-client") ?? "",
			sessionId: opened.sessionId,
		})?.generation,
	).toBe(2);
	await expect(client.openSession({ ...options, retain_on_disconnect: true })).rejects.toThrow("admission_conflict");
	expect((await client.admissions.page("client-retry", "manifest")).action).toBe("ready");
	expect(host.core.router.sessionCount).toBe(1);
}, 120_000);
