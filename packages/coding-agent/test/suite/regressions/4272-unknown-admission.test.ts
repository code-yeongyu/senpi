import { join } from "node:path";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { statusHost } from "../rpc-session-status-support.ts";
import { admissionCommands } from "./4272-admission-commands-support.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

it("RULING-94 refuses unknown, foreign and retired identities with byte-identical answers", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const foreign = host.client("foreign");
	const sessionPath = join(host.cwd, "ownership.jsonl");
	const own = await peer.request({ type: "open_session", sessionPath, admissionId: "own" });
	const bytes: string[] = [];
	const request = async () => {
		await host.writer.flush();
		const start = peer.received.length;
		await host.writer.withConnection("peer", () =>
			host.core.handle(
				JSON.stringify({
					id: "same-request",
					type: "get_state",
					sessionId: own.sessionId,
					admissionId: "unheld",
				}),
			),
		);
		await host.writer.flush();
		const replies = peer.received.slice(start);
		expect.soft(replies).toHaveLength(1);
		const line = replies[0] ?? "";
		expect.soft(line === "" ? undefined : JSON.parse(line)).toMatchObject({
			success: false,
			code: "unknown_admission",
			admissionId: "unheld",
		});
		bytes.push(line);
	};
	await request();
	await foreign.request({ type: "open_session", sessionPath, admissionId: "unheld" });
	await request();
	await peer.request({ type: "open_session", sessionPath, admissionId: "unheld" });
	host.writer.recoveryCheckpoints.retireRoute(
		{
			socketEpoch: host.writer.socketEpochOf("peer") ?? "",
			sessionId: String(own.sessionId),
		},
		"unheld",
	);
	host.writer.unregisterAdmission("peer", "unheld");
	await request();
	expect(new Set(bytes).size).toBe(1);
}, 120_000);

it("RULING-94 every routed command validates before dispatch and answers exactly once", async () => {
	expectTypeOf<(typeof admissionCommands)[number]>().toEqualTypeOf<RpcCommand["type"]>();
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	await peer.request({ type: "open_session", admissionId: "own" });
	await host.writer.flush();
	const lookup = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const open = vi.spyOn(RpcSessionRegistry.prototype, "openSession");
	const subscribe = vi.spyOn(host.writer.status, "subscribe");
	let serial = 0;
	for (const type of admissionCommands) {
		// Open and subscribe introduce an ID rather than selecting existing authority.
		const introduces = type === "open_session" || type === "subscribe_sessions";
		for (const admissionId of ["", "..", 1, null, ...(introduces ? [] : ["missing"])]) {
			const id = `table-${++serial}`;
			const from = peer.inbox.length;
			await host.writer.withConnection("peer", () =>
				host.core.handle(
					JSON.stringify({
						id,
						type,
						sessionId: "unattributable",
						admissionId,
					}),
				),
			);
			await host.writer.flush();
			const frames = peer.inbox.slice(from);
			expect.soft(frames, `${type}/${String(admissionId)} exactly one reply`).toHaveLength(1);
			expect.soft(frames[0], `${type}/${String(admissionId)}`).toMatchObject({
				id,
				type: "response",
				success: false,
				...(admissionId === "missing"
					? { code: "unknown_admission", admissionId }
					: { errorData: { reason: "malformed_request" } }),
			});
		}
	}
	expect(lookup).not.toHaveBeenCalled();
	expect(open).not.toHaveBeenCalled();
	expect(subscribe).not.toHaveBeenCalled();
	expect(host.core.router.sessionCount).toBe(1);
	expect(host.writer.status.connectionSize("peer")).toBe(0);
}, 120_000);

it("RULING-94 compact connection answers success and unattributable requests exactly once", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	await using host = await statusHost();
	const peer = host.client("peer");
	const own = await peer.request({ type: "open_session", admissionId: "own" });
	await host.writer.flush();
	for (const command of [
		{ type: "get_state", sessionId: own.sessionId, admissionId: "own" },
		{ type: "get_state", sessionId: own.sessionId },
		{ type: "get_state", sessionId: own.sessionId, admissionId: "missing" },
		{ type: "get_state", sessionId: "unattributable", admissionId: "own" },
		{ type: "get_state", admissionId: "missing" },
		{ type: "get_state", sessionId: "unattributable" },
		{ type: "get_state", sessionId: own.sessionId, admissionId: "" },
		{ type: "list_sessions" },
	]) {
		const start = peer.inbox.length;
		await host.writer.withConnection("peer", () => host.core.handle(JSON.stringify({ ...command, id: "invariant" })));
		await host.writer.flush();
		const replies = peer.inbox.slice(start).filter((frame) => frame.type === "response");
		expect.soft(replies, JSON.stringify(command)).toHaveLength(1);
		expect.soft(replies[0]).toMatchObject({ id: "invariant", success: expect.any(Boolean) });
	}
}, 120_000);
