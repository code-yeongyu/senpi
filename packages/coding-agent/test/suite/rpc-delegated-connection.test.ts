/**
 * senpi#5632: a connection that proved the endpoint's launch key may declare, before its first ordinary record, that
 * it acts for a principal with a set of granted method classes (`declare_delegation`). From then on the ENGINE checks
 * every record on that connection against its own class table before dispatch, so a forwarder keeps no table.
 * Security and protocol contract: the enumeration below is generated from `RPC_METHOD_CLASS`, never from a hand list,
 * so a method added to the engine is covered here the moment it is classified.
 *
 * Records travel over a real Unix socket through the bare host's public-key filter (`PublicRpcConnection`) into the
 * per-connection dispatch `runSocketHost` builds, on the in-process registry, with a faux provider.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai/compat";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../src/main.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import {
	classifyRpcMethod,
	describeRpcMethodClasses,
	RPC_METHOD_CLASS,
	RPC_METHOD_CLASSES_DIGEST,
	type RpcMethodClass,
	type RpcMethodType,
} from "../../src/modes/rpc/method-classes.ts";
import { validateRpcInboundRecord } from "../../src/modes/rpc/method-classes-schema.ts";
import { createHostCore } from "../../src/modes/rpc/multi-session-host.ts";
import { connectAuthenticatedRpcSocket } from "../../src/modes/rpc/rpc-auth-client.ts";
import { PublicRpcConnection } from "../../src/modes/rpc/rpc-public-auth.ts";
import { RpcPublicEndpoint } from "../../src/modes/rpc/rpc-public-key.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";
import { corpusRequest, NO_ID, type Opened, TODAY } from "../characterization/rpc-method-surface-corpus.ts";

type WireRecord = Record<string, unknown>;

/**
 * `RPC_METHOD_CLASSES_DIGEST` with `list_hands` (observe) and `select_hand` (device_admin) in the table (senpi#5938);
 * before them it was 4df5316e9c… (fecca3f8ca, which added `account_reset`).
 */
const DIGEST_ON_BASE = "85c74d833ae2071658f88062a9f7573d80002ffc8a4bd4351b0ceea21cd55acd";
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
const PRINCIPAL = { deviceId: "x5632-device" };
const LEAN_ARGS = ["--mode", "rpc", "--multi-session", "--no-extensions", "--no-skills", "--no-context-files"];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const SECRET_COMMAND = "x5632-secret";
const ANSWER_DEADLINE_MS = 20_000;

/**
 * The three inbound types that are not `RpcCommand`s answer a request by its `id`; each gets a record here, typed so a
 * new non-command inbound type fails tsc until it has one.
 */
const NON_COMMAND: { readonly [K in Exclude<RpcMethodType, RpcCommand["type"]>]: (sessionId: string) => WireRecord } = {
	extension_ui_response: (sessionId) => ({ sessionId, uiRequestId: NO_ID, value: "x" }),
	extension_ui_progress: (sessionId) => ({ sessionId, answers: {} }),
	host_response: (sessionId) => ({ sessionId, data: {} }),
};

class Peer {
	private readonly answers = new Map<string, (record: WireRecord) => void>();
	private readonly frames: WireRecord[] = [];
	private readonly watchers = new Set<(record: WireRecord) => void>();
	private serial = 0;
	readonly socket: Socket;
	readonly name: string;

	constructor(socket: Socket, name: string) {
		this.socket = socket;
		this.name = name;
		attachJsonlLineReader(socket, (line) => {
			const record = JSON.parse(line) as WireRecord;
			if (record.type === "response" && typeof record.id === "string") this.answers.get(record.id)?.(record);
			this.frames.push(record);
			for (const watch of this.watchers) watch(record);
		});
	}

	nextId(): string {
		return `${this.name}-${++this.serial}`;
	}

	send(record: WireRecord): Promise<WireRecord> {
		const id = typeof record.id === "string" ? record.id : this.nextId();
		const answered = this.answer(id, String(record.type));
		this.socket.write(`${JSON.stringify({ ...record, id })}\n`);
		return answered;
	}

	/**
	 * For a record the host may answer with nothing (an answer to a dialog nobody raised): resolves with its response if
	 * one precedes the answer to a `get_protocol_info` sent right behind it on this connection, else `undefined`.
	 */
	async sendSettled(record: WireRecord): Promise<WireRecord | undefined> {
		const id = this.nextId();
		let answer: WireRecord | undefined;
		this.answers.set(id, (response) => {
			answer = response;
		});
		this.socket.write(`${JSON.stringify({ ...record, id })}\n`);
		const sentinel = this.send({ type: "get_protocol_info", observe: true });
		await sentinel;
		this.answers.delete(id);
		return answer;
	}

	answer(id: string, type = "record"): Promise<WireRecord> {
		return new Promise<WireRecord>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`${this.name}: no answer to ${type} ${id}`)),
				ANSWER_DEADLINE_MS,
			);
			this.answers.set(id, (record) => {
				clearTimeout(timer);
				this.answers.delete(id);
				resolve(record);
			});
		});
	}

	frame(predicate: (record: WireRecord) => boolean): Promise<WireRecord> {
		const seen = this.frames.find(predicate);
		if (seen) return Promise.resolve(seen);
		return new Promise<WireRecord>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.watchers.delete(watch);
				reject(new Error(`${this.name}: no matching frame`));
			}, ANSWER_DEADLINE_MS);
			const watch = (record: WireRecord) => {
				if (!predicate(record)) return;
				clearTimeout(timer);
				this.watchers.delete(watch);
				resolve(record);
			};
			this.watchers.add(watch);
		});
	}
}

async function startHost() {
	const scratch = await mkdtemp(join(tmpdir(), "x5632-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir, { mode: 0o700 });
	for (const name of ["SENPI_CODING_AGENT_DIR", "OMO_CODING_AGENT_DIR"]) vi.stubEnv(name, agentDir);
	vi.stubEnv("SENPI_RPC_KEY_ROOT", agentDir);
	const faux = fauxProvider({ models: [{ id: "faux-1", reasoning: false, contextWindow: 128_000 }] });
	const writer = new SessionEventWriter(() => {});
	const core = createHostCore(
		{
			agentDir,
			cwd,
			permissionPreset: "full-access",
			createRuntime: createCliRuntimeFactory(
				{ parsed: parseArgs(LEAN_ARGS), cwd, agentDir, appMode: "rpc" },
				{
					extensionFactories: [
						(pi) => {
							pi.registerProvider(faux.provider);
							pi.registerCommand(SECRET_COMMAND, {
								description: "asks for a secret",
								handler: async (_args, ctx) => {
									await ctx.ui.input("Key", undefined, { secret: true });
								},
							});
						},
					],
				},
			),
			creationModel: { provider: faux.getModel().provider, modelId: "faux-1" },
		},
		writer,
		[],
	);
	const socketPath = join(scratch, "s");
	const endpoint = new RpcPublicEndpoint(agentDir, socketPath);
	await endpoint.publish();
	const sockets = new Set<Socket>();
	let connections = 0;
	// The bare host's wiring: the public-key filter in front of the per-connection dispatch, the connection
	// registered with the proof the filter delivers in band.
	const server: Server = createServer((raw) => {
		sockets.add(raw);
		const id = `socket-${++connections}`;
		const stream = new PublicRpcConnection(raw, endpoint, false).stream;
		stream.on("error", () => {});
		writer.registerConnection(id, socketSink(stream), { launchProof: "in_band" });
		raw.once("close", () => {
			sockets.delete(raw);
			writer.unregisterConnection(id);
		});
		attachJsonlLineReader(stream, (line) => void writer.withConnection(id, () => core.handle(line)));
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	let peers = 0;
	return {
		scratch,
		async proven(): Promise<Peer> {
			const { socket } = await connectAuthenticatedRpcSocket(socketPath, undefined, { keyRoot: agentDir });
			return new Peer(socket, `p${++peers}`);
		},
		async keyless(): Promise<Peer> {
			const socket = connect(socketPath);
			await new Promise<void>((resolve) => socket.once("connect", resolve));
			const peer = new Peer(socket, `k${++peers}`);
			expect(await peer.send({ type: "get_protocol_info" })).toMatchObject({ success: true });
			return peer;
		},
		async dispose(): Promise<void> {
			await core.router.dispose();
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await endpoint.dispose();
			await rm(scratch, { recursive: true, force: true });
			vi.unstubAllEnvs();
		},
	};
}

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

let host: Awaited<ReturnType<typeof startHost>>;

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

async function declare(peer: Peer, granted: readonly string[], principal: object = PRINCIPAL) {
	return peer.send({ type: "declare_delegation", principal, granted });
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
