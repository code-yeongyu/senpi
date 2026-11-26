/**
 * Wire vocabulary between the server and a session's tool child (senpi#3566).
 *
 * Every frame crosses the private channel as one length-prefixed binary frame (`codec.ts`), never as NDJSON. Payloads
 * above `REF_THRESHOLD` never travel inline: they move as an acknowledged `PayloadRef` (`payload-ref.ts`) in either
 * direction. `trace` is the only lossy frame class; it never carries a job result, a launch proof or a tick.
 */

const MIB = 1024 * 1024;

export const TOOL_CHILD_LIMITS = {
	/** Largest encoded frame body, in bytes; a larger length header is refused before its body is allocated. */
	frameBytes: 16 * MIB,
	/** Ordinary jobs one child runs at once; nested jobs are bounded by `hostCallCapacity()` instead. */
	jobs: 32,
	/** Wake notifications awaiting `wake_ack`, by count and by summed size; the next one waits (never dropped). */
	wakePending: 64,
	/** A job's streamed updates awaiting `update_ack`; the job's next `update()` waits for credit (never dropped). */
	updatesInFlight: 64,
	wakePendingBytes: 1 * MIB,
	HOST_CALL_ACTIVE: 8,
	HOST_CALL_WAITING: 256,
	/** A payload whose JSON exceeds this many bytes moves by reference, never inline. */
	REF_THRESHOLD: 4 * MIB,
	/** A ref still unacknowledged after this long is reported overdue (the writer still does not delete it). */
	refAckMs: 30_000,
	/** Bytes of ref files one side may own at once. */
	refsBudget: 1024 * MIB,
	tracePerSecond: 1024,
} as const;

export const LAUNCH_CONTAINMENTS = ["own-group", "inherited", "job", "breakaway"] as const;
export type LaunchContainment = (typeof LAUNCH_CONTAINMENTS)[number];

export const LAUNCH_LIFETIMES = ["owned", "detached"] as const;
export type LaunchLifetime = (typeof LAUNCH_LIFETIMES)[number];

/** Which surface asked for the process. */
export const LAUNCH_ORIGINS = ["tool", "terminal", "user_bash", "interpreter", "monitor", "kernel"] as const;
export type LaunchOrigin = (typeof LAUNCH_ORIGINS)[number];

/** The launch API the command came through; group semantics differ per API. */
export const LAUNCH_APIS = [
	"bun.spawn",
	"bun.spawnSync",
	"bun.shell",
	"cp.spawn",
	"cp.spawnSync",
	"cp.execFileSync",
	"pty.spawn",
] as const;
export type LaunchApi = (typeof LAUNCH_APIS)[number];

export const REF_NACK_REASONS = ["cancelled", "corrupt", "missing", "budget", "foreign"] as const;
export type RefNackReason = (typeof REF_NACK_REASONS)[number];

/** What a reverse call reaches on the server (DESIGN PART 1): a tool by `name`, the model, a reserved tool, the tool list. */
export const HOST_CALL_KINDS = [
	"tool",
	"completion",
	"reserved",
	"list_tools",
	"authorize",
	"lock_file",
	"unlock_file",
] as const;
export type HostCallKind = (typeof HOST_CALL_KINDS)[number];

/** A payload moved through a file in the channel generation's directory. The receiver derives the path itself. */
export interface PayloadRef {
	refId: string;
	/** The channel's child generation; refs of both directions live under that generation's directory. */
	generation: number;
	bytes: number;
	sha256: string;
}

/** One parsed transcript entry, with its canonical identity and its exact place in the file. */
export interface ParsedEntryMeta {
	id: string;
	/** Canonical parent from the file line, never from a compacted in-memory mirror. */
	parentId: string | null;
	lineOffset: number;
	lineBytes: number;
	/** Wire bytes minus line bytes after the canonical transform. */
	lineDelta: number;
	entry?: unknown;
}

export type TraceDetail = Readonly<Record<string, string | number | boolean>>;

/** Keys a `trace` detail may never carry: the lossy class never transports results, proofs or ticks. */
export const TRACE_RESERVED_KEYS = [
	"value",
	"valueRef",
	"result",
	"ref",
	"args",
	"argsRef",
	"ackTick",
	"invokeTick",
] as const;

export type ServerToChild =
	| { type: "hello_ack"; generation: number }
	| { type: "job"; jobId: string; kind: string; parentJobId?: string; args?: unknown; argsRef?: PayloadRef }
	| { type: "cancel"; jobId: string }
	| { type: "host_reply"; callId: string; value?: unknown; valueRef?: PayloadRef; error?: string }
	| { type: "host_call_refused"; callId: string; code: string }
	| { type: "launch_ack"; launchId: string }
	| { type: "wake_ack"; wakeId: string }
	| { type: "slot_query"; launchId: string }
	| { type: "ping"; seq: number }
	/** The server delivered the job's update `seq` (one credit back to the child). */
	| { type: "update_ack"; jobId: string; seq: number }
	| { type: "shutdown" };

export type ChildToServer =
	/** `jobKinds`: the job kinds this child runs (its manifest); a job of any other kind is refused before it is sent. */
	| { type: "hello"; generation: number; pid: number; protocol: number; jobKinds: string[] }
	| { type: "heartbeat"; seq: number }
	| { type: "pong"; seq: number }
	| { type: "cancel_ack"; jobId: string }
	| { type: "result"; jobId: string; value: unknown }
	| { type: "result_ref"; jobId: string; ref: PayloadRef }
	| { type: "job_error"; jobId: string; code: string; message: string }
	| { type: "job_refused"; jobId: string; code: string }
	| {
			type: "host_call";
			callId: string;
			jobId: string;
			kind: HostCallKind;
			name?: string;
			args?: unknown;
			argsRef?: PayloadRef;
	  }
	| {
			type: "launch";
			launchId: string;
			jobId: string;
			origin: LaunchOrigin;
			api: LaunchApi;
			containment: LaunchContainment;
			lifetime: LaunchLifetime;
			pid?: number;
			pgid?: number;
	  }
	| { type: "launch_proof"; launchId: string; ackTick: number | null; invokeTick: number }
	| { type: "launch_done"; launchId: string; exitCode?: number; signal?: string }
	| {
			type: "command_started";
			launchId: string;
			pid: number;
			startedAtMs: number;
			creatorInJob: boolean;
			breakaway: boolean;
	  }
	| { type: "slot_state"; launchId: string; ackTick: number | null; invokeTick: number | null; invocations: number }
	| { type: "wake"; wakeId: string; source: string; bytes: number; value?: unknown }
	| { type: "batch"; jobId: string; entries: ParsedEntryMeta[]; done: boolean }
	/** A running job's partial result, in order (`seq` from 1); large ones by acknowledged reference. */
	| { type: "update"; jobId: string; seq: number; value?: unknown; valueRef?: PayloadRef }
	| { type: "trace"; atMs: number; event: string; detail?: TraceDetail };

/** Either side acknowledges or refuses a ref the other side wrote. */
export type RefControl =
	| { type: "ref_ack"; refId: string }
	| { type: "ref_nack"; refId: string; reason: RefNackReason };

export type ToolChildMessage = ServerToChild | ChildToServer | RefControl;
export type ToolChildMessageType = ToolChildMessage["type"];
export type ToolChildMessageOf<T extends ToolChildMessageType> = Extract<ToolChildMessage, { type: T }>;

/** The only frame class a full budget may drop (counted). */
export const LOSSY_FRAME_TYPES: ReadonlySet<ToolChildMessageType> = new Set<ToolChildMessageType>(["trace"]);
