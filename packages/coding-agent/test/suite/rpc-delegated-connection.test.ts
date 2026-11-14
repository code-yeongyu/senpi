/**
 * senpi#5632: a connection that proved the endpoint's launch key may declare, before its first ordinary record, that
 * it acts for a principal with a set of granted method classes (`declare_delegation`). From then on the ENGINE checks
 * every record on that connection against its own class table before dispatch, so a forwarder keeps no table.
 * Security and protocol contract: the enumeration below is generated from `RPC_METHOD_CLASS`, never from a hand list,
 * so a method added to the engine is covered here the moment it is classified.
 *
 * Records travel over a real Unix socket through the bare host's public-key filter (`PublicRpcConnection`) into the
 * per-connection dispatch `createHostCore` builds, on the in-process registry, with a faux provider
 * (`rpc-delegated-host-support.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	classifyRpcMethod,
	describeRpcMethodClasses,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	type RpcMethodClass,
	type RpcMethodType,
} from "../../src/modes/rpc/method-classes.ts";
import { validateRpcInboundRecord } from "../../src/modes/rpc/method-classes-schema.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { corpusRequest, NO_ID, type Opened, TODAY } from "../characterization/rpc-method-surface-corpus.ts";
import {
	type DelegatedHost,
	declare,
	type Peer,
	PRINCIPAL,
	SECRET_COMMAND,
	startHost,
	type WireRecord,
} from "./rpc-delegated-host-support.ts";

/**
 * `RPC_METHOD_CLASSES_DIGEST` at the base this test runs on: main (with `list_hands` (observe) and `select_hand`
 * (device_admin) in the table, senpi#5938) plus senpi#5379, which moves `set_model` from `device_admin` to `dynamic`,
 * and senpi#6177, which adds `get_project_trust` (observe) and `set_project_trust`, `get_project_settings`, `set_project_setting`
 * (device_admin), and senpi#6307, which adds `read_project_file` and `write_project_file` (device_admin).
 * Delegated connections add methods outside the table, never a table entry.
 */
// senpi#6344 adds two cwd-naming device_admin commands: park_session and claim_session.
// senpi#6429 adds one device_admin command to the table, find_session, which moves the digest.
const DIGEST_ON_BASE = "3b9f36e0b7ba0bf3c416776ef46b5e87f037d445197716a879696ca89fe7186d";
const FORWARDABLE = [
	"observe",
	"drive",
	"answer",
	"thread",
	"device_admin",
] as const satisfies readonly RpcMethodClass[];
/** The `connection_local` methods that reach beyond the asking connection: they need `device_admin`. */
/** DS2b section 2c: the `connection_local` records that need a grant on a delegated connection; the rest act on it alone. */
const CONNECTION_LOCAL_NEEDS: Partial<Record<RpcMethodType, RpcMethodClass>> = {
	subscribe_sessions: "observe",
	record_user_activity: "drive",
	release_session: "device_admin",
	warm: "device_admin",
	reclaim_session: "device_admin",
	move_session: "device_admin",
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/**
 * The three inbound types that are not `RpcCommand`s answer a request by its `id`; each gets a record here, typed so a
 * new non-command inbound type fails tsc until it has one.
 */
const NON_COMMAND: { readonly [K in Exclude<RpcMethodType, RpcCommand["type"]>]: (sessionId: string) => WireRecord } = {
	extension_ui_response: (sessionId) => ({ sessionId, uiRequestId: NO_ID, value: "x" }),
	extension_ui_progress: (sessionId) => ({ sessionId, answers: {} }),
	host_response: (sessionId) => ({ sessionId, data: {} }),
};

/** Acceptance and reply shape, as X14 compares them: `ok{sorted data keys}` or `no:<errorCode>:<error>`. */
function signature(record: WireRecord | undefined, method: string, scratch: string): string {
	if (record === undefined) return "no answer";
	const envelope = record.command === method ? "" : `command=${String(record.command)}|`;
	const data = record.data;
	if (record.success !== true) {
		const text = String(record.error).split(scratch).join("<tmp>").replace(UUID, "<uuid>");
		return `${envelope}no:${String(record.errorCode ?? "")}:${text}`;
	}
	if (data === undefined) return `${envelope}ok`;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return `${envelope}ok:${typeof data}`;
	return `${envelope}ok{${Object.keys(data).sort().join(",")}}`;
}

/**
 * What a delegated connection needs for `record` and the refusal code without it (omo-relay-spec decision 0018):
 * its class, or for a `connection_local` record its section 2c grant, nothing for one acting on the asking connection.
 */
function requirement(
	type: RpcMethodType,
	record: WireRecord,
): { readonly needs: RpcMethodClass; readonly refusal: string } | "self" {
	const entry = RPC_METHOD_CLASS[type];
	const methodClass = typeof entry === "string" ? entry : classifyRpcMethod(record);
	if (methodClass === undefined) throw new Error(`the engine does not classify the ${type} test record`);
	if (methodClass !== "connection_local") return { needs: methodClass, refusal: "delegation_not_granted" };
	const needs = CONNECTION_LOCAL_NEEDS[type];
	return needs === undefined ? "self" : { needs, refusal: "delegation_local_only" };
}

/**
 * X14 corpus records the inbound schema validator refuses (no payload, or a partial one). A delegated connection must
 * accept them exactly as a local one does (DS2b decision 2): they run through the enumeration unchanged.
 */
const VALIDATOR_REFUSED: ReadonlySet<RpcMethodType> = new Set<RpcMethodType>([
	"get_recovery_page",
	"release_recovery",
	"cancel_attempt",
	"reset_stream",
	"set_retry_fallback",
]);

let host: DelegatedHost;

function sendFor(peer: Peer, type: RpcMethodType, record: WireRecord): Promise<WireRecord | undefined> {
	return Object.hasOwn(NON_COMMAND, type) ? peer.sendSettled(record) : peer.send(record);
}
let opener: Peer;

async function recordFor(type: RpcMethodType): Promise<WireRecord> {
	const opened = (await opener.send({ type: "open_session" })).data as Opened;
	return Object.hasOwn(TODAY, type)
		? corpusRequest(type, TODAY[type as RpcCommand["type"]], opened, host.scratch).record
		: { type, ...NON_COMMAND[type as keyof typeof NON_COMMAND](opened.sessionId) };
}

// vitest restores stubbed env before every test (`unstubEnvs`), so the host behaviour this suite compares against X14
// is pinned per test: attach grace (not SENPI_RPC_REQUIRE_ATTACH), no ambient socket, memory reports off.
beforeEach(() => {
	for (const name of ["OMO_RPC_SOCKET_PATH", "OMO_RPC_SOCKET", "SENPI_RPC_SOCKET", "PI_RPC_SOCKET"])
		vi.stubEnv(name, undefined);
	vi.stubEnv("SENPI_RPC_REQUIRE_ATTACH", undefined);
	for (const brand of ["SENPI", "OMO", "PI"])
		for (const name of ["MEMORY_REPORT", "MEMORY_REPORT_SNAPSHOT"]) vi.stubEnv(`${brand}_${name}`, "0");
});
beforeAll(async () => {
	host = await startHost();
	opener = await host.proven();
});
// Disposes every session the enumeration opened (several hundred).
afterAll(async () => {
	await host.dispose();
}, 120_000);

describe("senpi#5632: delegated connections are decided by the engine's own class table", () => {
	it("leaves the class table, and so its digest, as it was", () => {
		expect(RPC_METHOD_CLASSES_DIGEST).toBe(DIGEST_ON_BASE);
	});

	it("runs every permitted type of the table as on a local connection and refuses the rest, for each grant set", async () => {
		const local = await host.proven();
		const grantSets: ReadonlyArray<readonly RpcMethodClass[]> = [...FORWARDABLE.map((c) => [c]), FORWARDABLE];
		const delegated = await Promise.all(
			grantSets.map(async (granted) => {
				const peer = await host.proven();
				expect(await declare(peer, granted)).toMatchObject({ success: true, data: { granted } });
				return { granted: new Set<RpcMethodClass>(granted), peer };
			}),
		);
		const mismatches: string[] = [];
		const types = Object.keys(RPC_METHOD_CLASS) as RpcMethodType[];
		expect(types.length).toBeGreaterThan(100);
		for (const type of VALIDATOR_REFUSED)
			expect(validateRpcInboundRecord({ ...(await recordFor(type)), id: "x" }).ok, type).toBe(false);
		for (const type of types) {
			// A refused record never reaches a session, so it reuses the record the local connection ran; only a dispatched
			// one gets a fresh session. Grant sets run one after another: device-wide writers (credentials, settings) share
			// state across sessions, so running them concurrently would compare contention, not delegation.
			const shared = await recordFor(type);
			const required = requirement(type, shared);
			const expected = signature(await sendFor(local, type, shared), type, host.scratch);
			for (const { granted, peer } of delegated) {
				const refusal = required === "self" || granted.has(required.needs) ? undefined : required;
				const answer = await sendFor(peer, type, refusal === undefined ? await recordFor(type) : shared);
				const label = `${type} on [${[...granted].join(",")}]`;
				if (refusal === undefined) {
					const actual = signature(answer, type, host.scratch);
					if (actual !== expected) mismatches.push(`${label}: ran as ${actual}, local ${expected}`);
				} else if (
					answer === undefined ||
					answer.success !== false ||
					answer.command !== type ||
					answer.errorCode !== refusal.refusal ||
					(answer.errorData as WireRecord | undefined)?.class !== refusal.needs
				) {
					mismatches.push(
						`${label}: expected ${refusal.refusal}(${refusal.needs}), got ${JSON.stringify(answer)}`,
					);
				}
			}
		}
		expect(mismatches).toEqual([]);
	}, 400_000);

	it("refuses an unclassified type and a record that is not an object with a string type", async () => {
		const peer = await host.proven();
		expect(await declare(peer, FORWARDABLE)).toMatchObject({ success: true });
		expect(await peer.send({ type: "x5632_not_a_method" })).toMatchObject({
			success: false,
			command: "x5632_not_a_method",
			errorCode: "delegation_unclassified",
		});
		expect(await peer.send({ type: 5 })).toMatchObject({ success: false, errorCode: "delegation_malformed" });
		const refusals = (code: string) =>
			peer.frame((record) => record.type === "response" && record.errorCode === code && record.id === undefined);
		const notObject = refusals("delegation_malformed");
		peer.socket.write("[1]\n");
		expect(await notObject).toMatchObject({ success: false, command: "parse" });
		const parse = peer.frame(
			(record) =>
				record.type === "response" &&
				record.errorCode === "delegation_malformed" &&
				record.error !== undefined &&
				String(record.error).startsWith("Failed to parse"),
		);
		peer.socket.write(`{"type":\n`);
		expect(await parse).toMatchObject({ success: false, command: "parse" });
	});

	it("runs a schema-invalid record of a granted class as a local connection does", async () => {
		const local = await host.proven();
		const peer = await host.proven();
		expect(await declare(peer, FORWARDABLE)).toMatchObject({ success: true });
		const record = async () => ({
			type: "prompt",
			sessionId: ((await opener.send({ type: "open_session" })).data as Opened).sessionId,
		});
		const expected = signature(await local.send(await record()), "prompt", host.scratch);
		expect(signature(await peer.send(await record()), "prompt", host.scratch)).toBe(expected);
		expect(expected).not.toContain("delegation_");
	});

	it("lets a delegated connection declare its own roles with set_client_info, unfiltered", async () => {
		const peer = await host.proven();
		expect(await declare(peer, ["observe"])).toMatchObject({ success: true });
		expect(
			await peer.send({ type: "set_client_info", width: 80, capabilities: ["interactive_user", "secret_input_v1"] }),
		).toMatchObject({ success: true });
		expect(await peer.send({ type: "subscribe_sessions" })).toMatchObject({ success: true });
		expect(await peer.send({ type: "record_user_activity", kind: "draft" })).toMatchObject({
			success: false,
			errorCode: "delegation_local_only",
			errorData: { class: "drive" },
		});
	});

	it("refuses a declaration from a connection that did not prove the launch key", async () => {
		const keyless = await host.keyless();
		expect(await declare(keyless, ["observe"])).toMatchObject({
			success: false,
			command: "declare_delegation",
			errorCode: "delegation_unauthenticated",
		});
		expect(await keyless.send({ type: "list_sessions" })).toMatchObject({ success: true });
	});

	it("accepts only a narrowing re-declaration, and enforces it from the next record", async () => {
		const peer = await host.proven();
		expect(await declare(peer, ["observe", "drive"])).toMatchObject({ success: true });
		expect(await declare(peer, ["observe", "drive", "device_admin"])).toMatchObject({
			success: false,
			errorCode: "delegation_fixed",
		});
		expect(await declare(peer, ["observe"], { deviceId: "another-device" })).toMatchObject({
			success: false,
			errorCode: "delegation_fixed",
		});
		expect(await declare(peer, ["observe"])).toMatchObject({ success: true, data: { granted: ["observe"] } });
		const session = (await opener.send({ type: "open_session" })).data as Opened;
		expect(await peer.send({ type: "abort", sessionId: session.sessionId })).toMatchObject({
			success: false,
			errorCode: "delegation_not_granted",
			errorData: { class: "drive" },
		});
		expect(await peer.send({ type: "get_state", sessionId: session.sessionId })).toMatchObject({ success: true });
	});

	it("refuses a first declaration after any record other than get_protocol_info and authenticate", async () => {
		const peer = await host.proven();
		expect(await peer.send({ type: "get_protocol_info" })).toMatchObject({ success: true });
		expect(await peer.send({ type: "list_sessions" })).toMatchObject({ success: true });
		expect(await declare(peer, ["observe"])).toMatchObject({ success: false, errorCode: "delegation_late" });
	});

	it("enforces a declaration on the record written right behind it in the same chunk", async () => {
		const peer = await host.proven();
		const session = (await opener.send({ type: "open_session" })).data as Opened;
		const declared = peer.nextId();
		const shell = peer.nextId();
		const answers = [peer.answer(declared), peer.answer(shell)];
		peer.socket.write(
			`${JSON.stringify({ id: declared, type: "declare_delegation", principal: PRINCIPAL, granted: ["observe"] })}\n${JSON.stringify({ id: shell, type: "bash", sessionId: session.sessionId, command: "true" })}\n`,
		);
		const [declaration, bash] = await Promise.all(answers);
		expect(declaration).toMatchObject({ success: true });
		expect(bash).toMatchObject({
			success: false,
			errorCode: "delegation_not_granted",
			errorData: { class: "device_admin" },
		});
	});

	it("never lets a delegated connection answer a secret prompt another connection raised", async () => {
		const raiser = await host.proven();
		const opened = (await raiser.send({ type: "open_session" })).data as Opened;
		const sessionId = opened.sessionId;
		expect(
			await raiser.send({
				type: "set_client_info",
				width: 80,
				capabilities: ["interactive_user", "secret_input_v1"],
				sessionId,
			}),
		).toMatchObject({ success: true });
		const asked = raiser.frame((record) => record.type === "extension_ui_request" && record.secret === true);
		void raiser.send({ type: "prompt", sessionId, message: `/${SECRET_COMMAND}` });
		const request = await asked;
		const delegated = await host.proven();
		expect(await declare(delegated, FORWARDABLE)).toMatchObject({ success: true });
		const answer = {
			type: "extension_ui_response",
			sessionId,
			uiRequestId: request.id,
			answerId: "x5632-answer",
			secret: true,
			value: "stolen",
		};
		expect(await delegated.send(answer)).toMatchObject({ success: false, error: "secret_answer_refused" });
		expect(await raiser.send(answer)).toMatchObject({ success: true, disposition: "applied" });
	});

	it("classifies a record on request and describes the whole table in get_protocol_info", async () => {
		const peer = await host.proven();
		expect(await declare(peer, [])).toMatchObject({ success: true, data: { granted: [] } });
		expect(await peer.send({ type: "classify_record", record: { type: "prompt", message: "/x" } })).toMatchObject({
			success: true,
			data: { class: "device_admin", version: 1, digest: RPC_METHOD_CLASSES_DIGEST },
		});
		expect(await peer.send({ type: "classify_record", record: { type: "x5632_not_a_method" } })).toMatchObject({
			success: true,
			data: { class: null },
		});
		const info = await opener.send({ type: "get_protocol_info" });
		expect((info.data as WireRecord).method_classes).toEqual(describeRpcMethodClasses());
		expect((info.data as { capabilities: string[] }).capabilities).toContain("delegated_connection_v1");
	});
});

/**
 * senpi#5808: a delegated connection is a forwarder's channel for one viewer, so it ends whenever that viewer leaves.
 * The session it opened belongs to the forwarder, which keeps serving it to the next viewer: every open on a delegated
 * connection is retained, whatever `retain_on_disconnect` says, so its end detaches and never closes. A connection that
 * never declared keeps today's rule: closed with its last client unless it asked to be retained.
 */
describe("senpi#5808: a session opened over a delegated connection outlives that connection", () => {
	type Row = { sessionId: string; durableSessionId: string; retain_on_disconnect: boolean; attachments: number };

	async function rows(): Promise<Row[]> {
		return ((await opener.send({ type: "list_sessions" })).data as { sessions: Row[] }).sessions;
	}

	async function delegatedPeer(granted: readonly string[] = FORWARDABLE): Promise<Peer> {
		const peer = await host.proven();
		expect(await declare(peer, granted)).toMatchObject({ success: true });
		return peer;
	}

	async function openedThenDropped(peer: Peer, record: WireRecord = {}): Promise<string> {
		const { sessionId } = (await peer.send({ type: "open_session", ...record })).data as Opened;
		await host.drop(peer);
		return sessionId;
	}

	it("stays open, listed and attachable from a new connection after the delegated opener ends", async () => {
		const sessionId = await openedThenDropped(await delegatedPeer());
		const next = await delegatedPeer();
		const row = (await rows()).find((candidate) => candidate.sessionId === sessionId);
		expect(row).toMatchObject({ status: "open", attachments: 0, retain_on_disconnect: true });
		expect(
			await next.send({ type: "attach_session", sessionId, durableSessionId: row?.durableSessionId }),
		).toMatchObject({ success: true, data: { attached: true } });
		expect(await next.send({ type: "get_state", sessionId })).toMatchObject({
			success: true,
			data: { sessionId: row?.durableSessionId },
		});
	});

	it("retains a delegated open whatever retain_on_disconnect it sends", async () => {
		const asksFalse = await openedThenDropped(await delegatedPeer(), { retain_on_disconnect: false });
		const asksTrue = await openedThenDropped(await delegatedPeer(), { retain_on_disconnect: true });
		const listed = await rows();
		for (const sessionId of [asksFalse, asksTrue])
			expect(listed.find((row) => row.sessionId === sessionId)).toMatchObject({
				attachments: 0,
				retain_on_disconnect: true,
			});
	});

	it("decides at line receipt: an open whose delegated connection ends before it is dispatched is retained", async () => {
		const id = "x5808-ends-before-dispatch";
		host.writer.registerConnection(
			id,
			{ writeRaw: () => {}, waitForBackpressure: async () => {} },
			{ launchProof: "proven" },
		);
		const line = (record: WireRecord) =>
			host.writer.withConnection(id, () => host.core.handle(JSON.stringify(record)));
		await line({ type: "declare_delegation", principal: PRINCIPAL, granted: FORWARDABLE });
		const before = new Set((await rows()).map((row) => row.sessionId));
		// handle() reads the line synchronously up to its first await; the connection ends right behind that.
		const opening = line({ type: "open_session" });
		host.writer.unregisterConnection(id);
		await opening;
		await host.core.router.releaseConnection(id);
		const opened = (await rows()).filter((row) => !before.has(row.sessionId));
		expect(opened).toHaveLength(1);
		expect(opened[0]).toMatchObject({ attachments: 0, retain_on_disconnect: true });
	});

	it("keeps a connection that never declared on today's rule: closed with it unless it asked to be retained", async () => {
		const local = await host.proven();
		const sessionIdOf = async (record: WireRecord) =>
			((await local.send({ type: "open_session", ...record })).data as Opened).sessionId;
		const omitted = await sessionIdOf({});
		const asksFalse = await sessionIdOf({ retain_on_disconnect: false });
		const asksTrue = await sessionIdOf({ retain_on_disconnect: true });
		await host.drop(local);
		const next = await host.proven();
		for (const sessionId of [omitted, asksFalse])
			expect(await next.send({ type: "get_state", sessionId })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
		expect(await next.send({ type: "get_state", sessionId: asksTrue })).toMatchObject({ success: true });
	});

	it("never turns retention on through attach_session on a delegated connection", async () => {
		const owner = await host.proven();
		const { sessionId } = (await owner.send({ type: "open_session" })).data as Opened;
		const row = (await rows()).find((candidate) => candidate.sessionId === sessionId);
		const viewer = await delegatedPeer(["observe", "thread"]);
		expect(
			await viewer.send({ type: "attach_session", sessionId, durableSessionId: row?.durableSessionId }),
		).toMatchObject({ success: true });
		expect((await rows()).find((candidate) => candidate.sessionId === sessionId)).toMatchObject({
			attachments: 2,
			retain_on_disconnect: false,
		});
		await host.drop(viewer);
		expect((await rows()).find((candidate) => candidate.sessionId === sessionId)).toMatchObject({
			attachments: 1,
			retain_on_disconnect: false,
		});
		await host.drop(owner);
		expect((await rows()).some((candidate) => candidate.sessionId === sessionId)).toBe(false);
	});

	it("still refuses an open the delegation did not grant", async () => {
		const delegated = await delegatedPeer(["observe"]);
		const before = (await rows()).length;
		expect(await delegated.send({ type: "open_session" })).toMatchObject({
			success: false,
			errorCode: "delegation_not_granted",
		});
		expect(await rows()).toHaveLength(before);
	});
});
