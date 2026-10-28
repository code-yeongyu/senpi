import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
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
