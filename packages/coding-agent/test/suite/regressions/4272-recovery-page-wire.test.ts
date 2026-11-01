import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { CompactRecoveryCatalog } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryManifest } from "../../../src/modes/rpc/compact-recovery-manifest.ts";
import type { RecoveryCheckpoints } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryCaller } from "../../../src/modes/rpc/compact-recovery-types.ts";
import type { RpcCommand, RpcResponse } from "../../../src/modes/rpc/rpc-types.ts";
import { statusHost } from "../rpc-session-status-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import type { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

// Part of #4272 (S11b, R4.B3, RULING-56 (1), RULING-62, RULING-69 (1)): `get_recovery_page` is the additive host
// route to the checkpoint owner behind SENPI_ENGINE_SOCKET_COMPACT_UPDATES. On the real router with the flag on, the
// peer that holds a token pages a component of its real session as base64 of the raw stored bytes with a digest it
// verifies after decoding; another connection presenting that token learns nothing. With the flag off, the command
// and every legacy command answer byte-for-byte as before (golden).

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; failure: unknown }): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** A registered peer whose transport is held from the start, with room for a real session's baseline. */
function heldConnection(writer: SessionEventWriter, id: string): { release(): void } {
	let blocked = true;
	const waiters: (() => void)[] = [];
	writer.registerConnection(
		id,
		{
			writeRaw: () => undefined,
			waitForBackpressure: () =>
				blocked ? new Promise<void>((resolve) => void waiters.push(resolve)) : Promise.resolve(),
		},
		{ maxQueueBytes: 64 * 1024 * 1024 },
	);
	return {
		release: () => {
			blocked = false;
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

/** The first component (never a node) under the catalog root, with its catalog entry (length and leaf digest). */
async function firstComponentRef(
	checkpoints: RecoveryCheckpoints,
	token: Parameters<RecoveryCheckpoints["catalog"]>[0],
	caller: RecoveryCaller,
) {
	const manifest: RecoveryManifest = unwrap(await checkpoints.catalog(token, caller));
	const root = unwrap(await checkpoints.readCatalog(token, caller, manifest.catalogRoot));
	if (root.kind !== "node") throw new Error("the catalog root is a node");
	const index = root.entries.findIndex((entry) => entry.kind !== "node");
	if (index < 0) throw new Error("no component under the root");
	return {
		ref: `${manifest.catalogRoot}:${String(index).padStart(3, "0")}`,
		entry: root.entries[index] ?? expect.unreachable(),
	};
}

it("RULING-62 RULING-69 (1) the holder of a token pages a component of its real session over the wire; another connection presenting the token learns nothing", async () => {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	const opener = host.client("opener");
	const opened = await opener.request({ type: "open_session", cwd: host.cwd });
	const routing = String((opened.data as { sessionId: string }).sessionId);
	host.faux.setResponses([fauxAssistantMessage("an answer the cut accepts", { timestamp: 1 })]);
	const idle = opener.waitFor((record) => record.type === "agent_idle");
	await opener.request({ type: "prompt", sessionId: routing, message: "first" });
	await idle;
	const held = heldConnection(host.writer, "held");
	try {
		await pagesOverTheWire(host, routing, held);
	} finally {
		held.release();
		host.writer.unregisterConnection("held");
		await host[Symbol.asyncDispose]();
	}
});

async function pagesOverTheWire(
	host: Awaited<ReturnType<typeof statusHost>>,
	routing: string,
	held: { release(): void },
): Promise<void> {
	host.writer.attachConnectionToSession("held", routing);
	const checkpoints = host.writer.recoveryCheckpoints;
	const token =
		checkpoints.tokens().find((candidate) => candidate.admission.peer === "held") ??
		expect.unreachable(`no token: ${JSON.stringify(checkpoints.status())}`);
	const caller: RecoveryCaller = { socketEpoch: token.admission.socketEpoch, sessionId: routing };
	const { ref, entry } = await firstComponentRef(checkpoints, token, caller);
	const send = (via: string, fields: Record<string, unknown>): Promise<RpcResponse | undefined> =>
		host.writer.withConnection(via, () =>
			host.core.router.handle({
				id: `${via}-page`,
				type: "get_recovery_page",
				sessionId: routing,
				token: token.id,
				admissionId: token.admission.admissionId,
				componentRef: ref,
				requestId: "r-1",
				...fields,
			} as RpcCommand),
		);
	const answer = await send("held", {});
	expect(answer).toMatchObject({
		id: "held-page",
		type: "response",
		command: "get_recovery_page",
		success: true,
		data: {
			token: token.id,
			generation: token.admission.generation,
			componentRef: ref,
			ordinal: 1,
			offset: 0,
			complete: true,
			cursor: null,
			requestId: "r-1",
		},
	});
	const data = (answer as { data: { bytes: string; length: number; digest: string } }).data;
	const raw = Buffer.from(data.bytes, "base64");
	expect(raw.length).toBe(data.length);
	expect(raw.length).toBe(entry.length);
	expect(specDigest("fragment", raw)).toBe(data.digest);
	expect(specDigest("leaf", raw)).toBe(entry.digest);
	expect(JSON.parse(raw.toString("utf16le"))).toMatchObject({ format: expect.stringMatching(/^senpi-recovery-/) });
	// The opener holds the session too, but the token was minted for the held peer: unknown, with no generation.
	const foreign = await send("opener", {});
	expect(foreign).toEqual({
		id: "opener-page",
		type: "response",
		command: "get_recovery_page",
		success: false,
		error: "recovery_repair_needed",
		errorCode: "recovery_repair_needed",
		errorData: { kind: "repair_needed", reason: "unknown_token" },
	});
	const busy = await send("held", { requestId: "r-2", cursor: "p1:1:0:00000000000000000000000000000000" });
	expect(busy).toMatchObject({
		success: false,
		error: "recovery_invalid_cursor",
		errorData: { reason: "invalid_cursor", hint: "restart_from_catalog" },
	});
	held.release();
	await host.writer.flush();
	expect(checkpoints.open).toBe(0);
	expect(await send("held", { requestId: "r-3" })).toMatchObject({
		success: false,
		errorData: { reason: "unknown_token" },
	});
}

it("RULING-69 (2) a peer that disconnects during a slow first open aborts it: the open stops typed aborted, its socket slot and the token are freed, nothing is cached", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	const opener = host.client("opener");
	const opened = await opener.request({ type: "open_session", cwd: host.cwd });
	const routing = String((opened.data as { sessionId: string }).sessionId);
	host.faux.setResponses([fauxAssistantMessage("an answer the cut accepts", { timestamp: 1 })]);
	const idle = opener.waitFor((record) => record.type === "agent_idle");
	await opener.request({ type: "prompt", sessionId: routing, message: "first" });
	await idle;
	const held = heldConnection(host.writer, "held");
	host.writer.attachConnectionToSession("held", routing);
	const checkpoints = host.writer.recoveryCheckpoints;
	const pages = host.writer.recoveryPages ?? expect.unreachable("the flag is on");
	const token =
		checkpoints.tokens().find((candidate) => candidate.admission.peer === "held") ??
		expect.unreachable(`no token: ${JSON.stringify(checkpoints.status())}`);
	const { ref } = await firstComponentRef(checkpoints, token, {
		socketEpoch: token.admission.socketEpoch,
		sessionId: routing,
	});
	// The first open is slow: its verification waits at the gate until the test lets it go.
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<AbortSignal | undefined>();
	const settled: unknown[] = [];
	const leafReads = vi.spyOn(CompactContentStore.prototype, "readLeaf");
	let readsAtGate = -1;
	const read = CompactRecoveryCatalog.prototype.read;
	vi.spyOn(CompactRecoveryCatalog.prototype, "read").mockImplementation(async function (
		this: CompactRecoveryCatalog,
		...args: Parameters<CompactRecoveryCatalog["read"]>
	) {
		entered.resolve(args[4]);
		await gate.promise;
		readsAtGate = leafReads.mock.calls.length;
		try {
			const opened = await read.apply(this, args);
			settled.push(opened.kind);
			return opened;
		} catch (cause) {
			settled.push(cause);
			throw cause;
		}
	});
	const answer = host.writer.withConnection("held", () =>
		host.core.router.handle({
			id: "held-page",
			type: "get_recovery_page",
			sessionId: routing,
			token: token.id,
			admissionId: token.admission.admissionId,
			componentRef: ref,
			requestId: "r-1",
		} as RpcCommand),
	);
	try {
		const signal = await entered.promise;
		expect(pages.status().outstanding, "the slow open holds one socket slot").toBe(1);
		expect(signal?.aborted, "the open runs under its connection's lifetime").toBe(false);
		// The peer goes away the way the socket host drops it: the transport is unregistered at once, and its sessions
		// are released on the command chain (after this connection's in-flight command), so that release is not awaited.
		const dropped = host.drop("held");
		expect(signal?.aborted, "the disconnect aborts the in-flight open").toBe(true);
		gate.resolve();
		await dropped;
	} finally {
		gate.resolve();
		held.release();
	}
	const refused = await answer;
	expect(refused).toMatchObject({ success: false, errorData: { kind: "repair_needed", reason: "peer_gone" } });
	expect(settled, "the verification stopped typed aborted, before any component byte was read").toHaveLength(1);
	expect(settled[0]).toBeInstanceOf(CompactReadError);
	expect(settled[0]).toMatchObject({ reason: "aborted" });
	expect(readsAtGate, "the held open reached its gate").toBeGreaterThanOrEqual(0);
	// After the gate the catalog walk reads only the root node and the component's pointer side (a one-level ref); the
	// component's own leaves are read inside openFrozenBytes, which checks the signal before each one.
	expect(leafReads.mock.calls.length - readsAtGate, "only the catalog walk's two reads, no component leaf").toBe(2);
	expect(pages.status(), "the slot and the token's request state are freed; nothing is cached").toMatchObject({
		tokens: 0,
		outstanding: 0,
		cachedBytes: 0,
	});
	expect(checkpoints.verifiedComponents, "an aborted open leaves no verified component").toBe(0);
	held.release();
	expect(checkpoints.open, "the disconnected peer's token is reclaimed").toBe(0);
});

it("golden: with the flag off, get_recovery_page and the legacy read commands answer exactly as before", async () => {
	await using host = await statusHost();
	const client = host.client("legacy");
	const opened = await client.request({ type: "open_session", cwd: host.cwd });
	const sessionId = String((opened.data as { sessionId: string }).sessionId);
	expect(host.writer.recoveryPages, "no page route exists with the flag off").toBeUndefined();
	const page = await client.request({
		type: "get_recovery_page",
		sessionId,
		token: "socket-1:1",
		admissionId: "attach-1",
		componentRef: "c-0000000000000001:000",
		requestId: "r-1",
	});
	expect(page).toEqual({
		id: page.id,
		type: "response",
		command: "get_recovery_page",
		success: false,
		error: "Unknown command: get_recovery_page",
		sessionId,
	});
	const entries = await client.request({ type: "get_entries", sessionId });
	expect(Object.keys(entries).sort()).toEqual(["command", "data", "id", "sessionId", "success", "type"]);
	expect(Object.keys(entries.data as object).sort()).toEqual(["entries", "leafId"]);
	const tree = await client.request({ type: "get_tree", sessionId });
	expect(Object.keys(tree.data as object).sort()).toEqual(["leafId", "tree"]);
});
