import { join } from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { ADMISSION_LIMITS, CompactAdmissions } from "../../../src/modes/rpc/compact-admissions.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { statusHost } from "../rpc-session-status-support.ts";
import { admissionCommands } from "./4272-admission-commands-support.ts";

vi.mock("node:fs/promises", { spy: true });
const actual = await vi.importActual<typeof fs>("node:fs/promises");

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

it.each(["admission_busy", "storage_unavailable"])(
	"RULING-94 cancel replies exactly once when the pre-dispatch store reports %s",
	async (reason) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		await using host = await statusHost();
		const peer = host.client("peer");
		const run = vi.spyOn(CompactAdmissions.prototype, "run");
		await peer.request({ type: "open_session", admissionId: "own" });
		const ledger = run.mock.contexts[0];
		if (!(ledger instanceof CompactAdmissions)) throw new Error("missing host admission owner");
		const epoch = host.writer.socketEpochOf("peer");
		if (epoch === undefined) throw new Error("missing peer epoch");
		await host.writer.flush();
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const reads: Promise<boolean>[] = [];
		const read = vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
			if (String(args[0]).includes("senpi-admissions-")) {
				if (reason === "storage_unavailable") throw Object.assign(new Error("fixture I/O"), { code: "EIO" });
				entered.resolve();
				await finish.promise;
			}
			return actual.readFile(...args);
		});
		try {
			if (reason === "admission_busy") {
				for (let index = 0; index < ADMISSION_LIMITS.hot; index++) reads.push(ledger.pending(epoch, "missing"));
				await entered.promise;
			}
			const start = peer.inbox.length;
			const lookup = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
			const cancel = vi.spyOn(ledger, "cancel");
			const handled = host.writer.withConnection("peer", () =>
				host.core.handle(JSON.stringify({ id: "failed-store", type: "cancel_attempt", admissionId: "missing" })),
			);
			await expect.soft(handled).resolves.toBeUndefined();
			await host.writer.flush();
			const replies = peer.inbox.slice(start);
			expect.soft(replies).toHaveLength(1);
			expect.soft(replies[0]).toMatchObject({
				id: "failed-store",
				type: "response",
				command: "cancel_attempt",
				success: false,
				errorCode: `admission_${reason}`,
				errorData: { kind: "request_refused", reason, hint: "new_request" },
			});
			expect(lookup).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(host.core.router.sessionCount).toBe(1);
			expect(host.writer.status.connectionSize("peer")).toBe(0);
		} finally {
			finish.resolve();
			await Promise.all(reads);
			read.mockRestore();
		}
	},
	120_000,
);
