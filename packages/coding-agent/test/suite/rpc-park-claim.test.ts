import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { isObservingRequest } from "../../src/modes/rpc/host-observe-request.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { parkClaimHost } from "./rpc-park-claim-support.ts";

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] }));
afterEach(() => vi.useRealTimers());

it("claims the already built runtime, with ordinary open ownership and reply, then replaces it in the background", async () => {
	await using host = await parkClaimHost();
	const profile = { cwd: host.cwd, context: { role: "child" } };
	expect(await host.request({ type: "park_session", ...profile })).toMatchObject({
		success: true,
		data: { state: "parked" },
	});
	expect(host.builds).toBe(1);
	const original = host.harnesses[0].session;
	const claimed = await host.request({ type: "claim_session", ...profile, retain_on_disconnect: true });
	expect(claimed).toMatchObject({
		command: "claim_session",
		success: true,
		data: { sessionId: "rpc-1", state: { sessionId: original.sessionId } },
	});
	expect(host.builds).toBe(1);
	expect(await host.request({ type: "claim_session", ...profile })).toMatchObject({ data: { claimed: false } });
	expect(host.registry.list()).toEqual([
		expect.objectContaining({ sessionId: "rpc-1", attachments: 1, retain_on_disconnect: true }),
	]);
	expect(await host.router.releaseConnection("owner")).toEqual([]);
	expect(host.registry.list()[0].attachments).toBe(0);
	await vi.advanceTimersByTimeAsync(0);
	expect(await host.request({ type: "park_session", ...profile })).toMatchObject({
		data: { state: "already_parked" },
	});
	expect(host.builds).toBe(2);
	expect(await host.request({ type: "claim_session", ...profile })).toMatchObject({ data: { sessionId: "rpc-2" } });
});

it("hands out a claimed session in the same lifecycle as an ordinary open, never held (#6350 review)", async () => {
	await using host = await parkClaimHost();
	const opened = await host.request({ type: "open_session", cwd: host.cwd });
	await host.request({ type: "park_session", cwd: host.cwd, context: { lane: "parked" } });
	const claimed = await host.request({ type: "claim_session", cwd: host.cwd, context: { lane: "parked" } });
	const lifecycleOf = (response: unknown) => {
		const { state, holds, runPaused } = (
			response as { data: { state: { lifecycle: { state: string; holds: unknown[]; runPaused: boolean } } } }
		).data.state.lifecycle;
		return { state, holds, runPaused };
	};
	expect(lifecycleOf(claimed)).toEqual(lifecycleOf(opened));
	expect(lifecycleOf(claimed)).toEqual({ state: "done", holds: [], runPaused: false });
});

it("matches canonical context order and kind, and never builds on a miss", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd, kind: "worker", context: { b: "2", a: "1" } });
	for (const fields of [{ kind: "interactive" }, { context: { a: "different" } }])
		expect(await host.request({ type: "claim_session", cwd: host.cwd, ...fields } as RpcCommand)).toMatchObject({
			data: { claimed: false },
		});
	expect(host.builds).toBe(1);
	expect(
		await host.request({ type: "claim_session", cwd: host.cwd, kind: "worker", context: { a: "1", b: "2" } }),
	).toMatchObject({ data: { sessionId: "rpc-1" } });
	expect(host.registry.list()[0].context).toMatchObject({ a: "1", b: "2", host_instance: "park-host" });
});

it("keeps parks out of registry counts, listings, session files, and status until claim", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "subscribe_sessions", include_workers: true }, "observer");
	await host.request({ type: "park_session", cwd: host.cwd });
	expect(host.registry.list()).toEqual([]);
	expect(host.registry.size).toBe(0);
	expect(host.router.sessionCount).toBe(0);
	expect(host.sizes.every((size) => size === 0)).toBe(true);
	expect(await host.request({ type: "list_sessions", include_workers: true })).toMatchObject({
		data: { sessions: [] },
	});
	expect(host.harnesses[0].session.sessionFile).toBeUndefined();
	expect(host.registry.peek("rpc-1")?.durableSessionId).toBeUndefined();
	expect(
		host.records.filter((record) => record.type === "session_opened" || record.type === "session_status"),
	).toEqual([]);
	await host.request({ type: "claim_session", cwd: host.cwd });
	expect(host.harnesses[0].session.sessionFile).toBeDefined();
	expect(host.registry.size).toBe(1);
	expect(host.records.some((record) => record.type === "session_opened")).toBe(true);
	expect(host.records.some((record) => record.type === "session_status")).toBe(true);
});

it("coalesces concurrent parks and caps only speculative profiles", async () => {
	await using host = await parkClaimHost();
	host.holdBuilds();
	const first = host.request({ type: "park_session", cwd: host.cwd });
	const second = host.request({ type: "park_session", cwd: host.cwd });
	host.releaseBuilds();
	await Promise.all([first, second]);
	expect(host.builds).toBe(1);
	for (let i = 1; i < 4; i++) await host.request({ type: "park_session", cwd: host.cwd, context: { role: `${i}` } });
	expect(await host.request({ type: "park_session", cwd: host.cwd, context: { role: "overflow" } })).toMatchObject({
		data: { state: "full" },
	});
	expect(host.builds).toBe(4);
	expect(await host.request({ type: "open_session", cwd: host.cwd })).toMatchObject({ success: true });
});

it("expires an idle park and closes its runtime without a terminal session record", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const durable = host.harnesses[0].session.sessionId;
	await vi.advanceTimersByTimeAsync(60_000);
	await host.closed(durable);
	expect(await host.request({ type: "claim_session", cwd: host.cwd })).toMatchObject({ data: { claimed: false } });
	expect(host.records.some((record) => record.type === "session_closed" || record.type === "session_parked")).toBe(
		false,
	);
});

it.each(["drain", "handoff", "stop"] as const)("%s closes parks and writes nothing for a successor", async (action) => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const durable = host.harnesses[0].session.sessionId;
	if (action === "stop") await host.router.dispose();
	else {
		host.router.beginDrain();
		await host.exited;
	}
	await host.closed(durable);
	expect(host.registry.size).toBe(0);
	expect((await readdir(host.cwd)).includes("handover-parked")).toBe(false);
	expect(host.records.some((record) => record.type === "session_parked")).toBe(false);
});

it.each([
	{ sessionPath: "/a/session.jsonl" },
	{ durableSessionId: "12345678-1234-4123-8123-123456789abc" },
	{ expectedHostInstance: "park-host" },
	{ admissionId: "compact-attempt" },
	{ env: { OMOCAT_LANE: "other" } },
	{ spawnedBy: { parentSessionId: "parent", rootSessionId: "root", taskId: "task" } },
])("leaves the park available when claim cannot apply %j after construction", async (options) => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	expect(await host.request({ type: "claim_session", cwd: host.cwd, ...options })).toMatchObject({
		success: true,
		data: { claimed: false },
	});
	expect(host.builds).toBe(1);
	expect(await host.request({ type: "claim_session", cwd: host.cwd })).toMatchObject({ data: { sessionId: "rpc-1" } });
});

it("applies model, thinking and permission choices through the live command semantics", async () => {
	await using host = await parkClaimHost();
	await host.request({ type: "park_session", cwd: host.cwd });
	const model = host.harnesses[0].models[1];
	const reply = await host.request({
		type: "claim_session",
		cwd: host.cwd,
		provider: model.provider,
		modelId: model.id,
		thinkingLevel: "low",
		permissionPreset: "ask",
		promptSurface: "app",
		browserEngine: "none",
	});
	expect(reply, JSON.stringify(reply)).toMatchObject({
		success: true,
		data: { permissionPreset: "ask", state: { model: { id: "second" }, thinkingLevel: "low" } },
	});
	expect(host.registry.peek("rpc-1")?.profile).toMatchObject({ promptSurface: "app", browserEngine: "none" });
	expect(host.builds).toBe(1);
});

it("advertises park_claim, and a park request never becomes an idle-exit attachment", async () => {
	await using host = await parkClaimHost();
	expect(await host.request({ type: "get_protocol_info" })).toMatchObject({
		data: { capabilities: expect.arrayContaining(["park_claim"]) },
	});
	expect(isObservingRequest(JSON.stringify({ type: "park_session", cwd: host.cwd }))).toBe(true);
	expect(isObservingRequest(JSON.stringify({ type: "claim_session", cwd: host.cwd, observe: true }))).toBe(false);
});
