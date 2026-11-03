import {
	HOST_CALL_KINDS,
	LAUNCH_APIS,
	LAUNCH_CONTAINMENTS,
	LAUNCH_LIFETIMES,
	LAUNCH_ORIGINS,
	REF_NACK_REASONS,
	type ToolChildMessage,
	type ToolChildMessageType,
	TRACE_RESERVED_KEYS,
} from "./protocol.ts";

type FieldKind =
	| "string"
	| "number"
	| "boolean"
	| "json"
	| "ref"
	| "entries"
	| "detail"
	| "number|null"
	| "strings"
	| readonly string[];

interface FieldRule {
	kind: FieldKind;
	optional?: true;
}

const req = (kind: FieldKind): FieldRule => ({ kind });
const opt = (kind: FieldKind): FieldRule => ({ kind, optional: true });

const SHAPES = {
	hello_ack: { generation: req("number") },
	job: {
		jobId: req("string"),
		kind: req("string"),
		parentJobId: opt("string"),
		args: opt("json"),
		argsRef: opt("ref"),
	},
	cancel: { jobId: req("string") },
	host_reply: { callId: req("string"), value: opt("json"), valueRef: opt("ref"), error: opt("string") },
	host_call_refused: { callId: req("string"), code: req("string") },
	launch_ack: { launchId: req("string") },
	wake_ack: { wakeId: req("string") },
	slot_query: { launchId: req("string") },
	ping: { seq: req("number") },
	update_ack: { jobId: req("string"), seq: req("number") },
	shutdown: {},
	hello: { generation: req("number"), pid: req("number"), protocol: req("number"), jobKinds: req("strings") },
	heartbeat: { seq: req("number") },
	pong: { seq: req("number") },
	cancel_ack: { jobId: req("string") },
	result: { jobId: req("string"), value: req("json") },
	result_ref: { jobId: req("string"), ref: req("ref") },
	job_error: { jobId: req("string"), code: req("string"), message: req("string") },
	job_refused: { jobId: req("string"), code: req("string") },
	host_call: {
		callId: req("string"),
		jobId: req("string"),
		kind: req(HOST_CALL_KINDS),
		name: opt("string"),
		args: opt("json"),
		argsRef: opt("ref"),
	},
	launch: {
		launchId: req("string"),
		jobId: req("string"),
		origin: req(LAUNCH_ORIGINS),
		api: req(LAUNCH_APIS),
		containment: req(LAUNCH_CONTAINMENTS),
		lifetime: req(LAUNCH_LIFETIMES),
		pid: opt("number"),
		pgid: opt("number"),
	},
	launch_proof: { launchId: req("string"), ackTick: req("number|null"), invokeTick: req("number") },
	launch_done: { launchId: req("string"), exitCode: opt("number"), signal: opt("string") },
	command_started: {
		launchId: req("string"),
		pid: req("number"),
		startedAtMs: req("number"),
		creatorInJob: req("boolean"),
		breakaway: req("boolean"),
	},
	slot_state: {
		launchId: req("string"),
		ackTick: req("number|null"),
		invokeTick: req("number|null"),
		invocations: req("number"),
	},
	wake: { wakeId: req("string"), source: req("string"), bytes: req("number"), value: opt("json") },
	batch: { jobId: req("string"), entries: req("entries"), done: req("boolean") },
	update: { jobId: req("string"), seq: req("number"), value: opt("json"), valueRef: opt("ref") },
	trace: { atMs: req("number"), event: req("string"), detail: opt("detail") },
	ref_ack: { refId: req("string") },
	ref_nack: { refId: req("string"), reason: req(REF_NACK_REASONS) },
} satisfies Record<ToolChildMessageType, Record<string, FieldRule>>;

export const TOOL_CHILD_MESSAGE_TYPES: readonly string[] = Object.keys(SHAPES);

const REF_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RESERVED: ReadonlySet<string> = new Set(TRACE_RESERVED_KEYS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export const isRefId = (value: unknown): value is string => typeof value === "string" && REF_ID.test(value);

function isPayloadRef(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRefId(value.refId) &&
		isCount(value.generation) &&
		isCount(value.bytes) &&
		typeof value.sha256 === "string" &&
		SHA256.test(value.sha256)
	);
}

function isEntryMeta(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		(value.parentId === null || typeof value.parentId === "string") &&
		isCount(value.lineOffset) &&
		isCount(value.lineBytes) &&
		Number.isSafeInteger(value.lineDelta)
	);
}

function isTraceDetail(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return Object.entries(value).every(
		([key, item]) =>
			!RESERVED.has(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean"),
	);
}

function matches(kind: FieldKind, value: unknown): boolean {
	if (typeof kind !== "string") return typeof value === "string" && kind.includes(value);
	switch (kind) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "json":
			return value !== undefined;
		case "ref":
			return isPayloadRef(value);
		case "entries":
			return Array.isArray(value) && value.every(isEntryMeta);
		case "detail":
			return isTraceDetail(value);
		case "number|null":
			return value === null || (typeof value === "number" && Number.isFinite(value));
		case "strings":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
	}
}

const isMessageType = (value: unknown): value is ToolChildMessageType =>
	typeof value === "string" && Object.hasOwn(SHAPES, value);

/**
 * Boundary check for a decoded frame: a known `type`, every required field of the right kind, no unknown field.
 * An unknown field is refused rather than ignored, so a `trace` frame can never smuggle a result, proof or tick.
 */
export function isToolChildMessage(value: unknown): value is ToolChildMessage {
	if (!isRecord(value) || !isMessageType(value.type)) return false;
	const rules: Record<string, FieldRule> = SHAPES[value.type];
	for (const key of Object.keys(value)) if (key !== "type" && !Object.hasOwn(rules, key)) return false;
	return Object.entries(rules).every(([key, rule]) =>
		value[key] === undefined ? rule.optional === true : matches(rule.kind, value[key]),
	);
}
