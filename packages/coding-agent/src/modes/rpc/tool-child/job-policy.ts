/**
 * The tool child's job policy (senpi#3566, plan todo 6; DESIGN PART 1 (c)). Pure decisions over an injected clock:
 * per-kind server backstop deadlines and retry rules, the cancel ladder, control liveness and the crash loop. The
 * client applies them; nothing here starts a timer of its own.
 */

export interface KindPolicy {
	/** Server backstop in ms for a job of this kind, from its arguments; `undefined` = no backstop (liveness bounds it). */
	readonly backstopMs: (args: unknown) => number | undefined;
	readonly idempotent: boolean;
	/** What the user reads when the backstop fires. */
	readonly userText: string;
}

const MB10 = 10 * 1024 * 1024;

function numberField(args: unknown, field: string): number | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = Reflect.get(args, field);
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const fixed = (ms: number) => () => ms;
const perTenMb = (baseMs: number, field: string) => (args: unknown) =>
	baseMs + 1_000 * Math.ceil((numberField(args, field) ?? 0) / MB10);

export const KIND_POLICIES: Readonly<Record<string, KindPolicy>> = {
	"tool.grep": { backstopMs: fixed(120_000), idempotent: true, userText: "The search took too long and was stopped." },
	"tool.find": {
		backstopMs: fixed(120_000),
		idempotent: true,
		userText: "The file search took too long and was stopped.",
	},
	"tool.glob": {
		backstopMs: fixed(120_000),
		idempotent: true,
		userText: "The file search took too long and was stopped.",
	},
	"tool.ls": {
		backstopMs: fixed(120_000),
		idempotent: true,
		userText: "Listing the directory took too long and was stopped.",
	},
	"tool.read": {
		backstopMs: fixed(60_000),
		idempotent: true,
		userText: "Reading the file took too long and was stopped.",
	},
	"tool.edit": { backstopMs: fixed(120_000), idempotent: false, userText: "The edit took too long and was stopped." },
	"tool.write": {
		backstopMs: fixed(120_000),
		idempotent: false,
		userText: "Writing the file took too long and was stopped.",
	},
	"tool.apply_patch": {
		backstopMs: fixed(120_000),
		idempotent: false,
		userText: "Applying the patch took too long and was stopped.",
	},
	"session.parse": {
		backstopMs: perTenMb(30_000, "bytes"),
		idempotent: true,
		userText: "Reading the session took too long and was stopped.",
	},
	"history.spool": {
		backstopMs: perTenMb(60_000, "lineBytes"),
		idempotent: true,
		userText: "Saving the session history took too long and was stopped.",
	},
	"compaction.prepare": {
		backstopMs: fixed(180_000),
		idempotent: true,
		userText: "Preparing the compaction took too long and was stopped.",
	},
	"eval.cell": { backstopMs: () => undefined, idempotent: false, userText: "The cell was stopped." },
};

/** The longest a `module` / `offload.*` job may run, on the child and in-process alike. */
export const OFFLOAD_MAX_MS = 300_000;
const MODULE_KIND = "module";

/** The policy for one job: the table, `offload.<id>` / `module` (caller value, max 300 s), or a `qa.*` fixture kind. */
export function policyFor(
	kind: string,
	options: { readonly idempotent?: boolean; readonly deadlineMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): KindPolicy {
	const known = KIND_POLICIES[kind];
	if (known !== undefined) return known;
	if (kind === MODULE_KIND || kind.startsWith("offload.")) {
		const deadline = Math.min(options.deadlineMs ?? OFFLOAD_MAX_MS, OFFLOAD_MAX_MS);
		return {
			backstopMs: () => deadline,
			idempotent: options.idempotent === true,
			userText: "The tool took too long and was stopped.",
		};
	}
	const fromEnv = fixtureDeadline(kind, options.env ?? process.env);
	return {
		backstopMs: () => fromEnv ?? options.deadlineMs,
		idempotent: options.idempotent === true,
		userText: `The ${kind} job took too long and was stopped.`,
	};
}

/** `SENPI_TOOL_CHILD_DEADLINE_<KIND>_MS` for a `qa.*` fixture kind (`qa.sleep` -> `..._QA_SLEEP_MS`). */
export function fixtureDeadline(kind: string, env: NodeJS.ProcessEnv): number | undefined {
	if (!kind.startsWith("qa.") && !kind.startsWith("qa_")) return undefined;
	const raw = env[`SENPI_TOOL_CHILD_DEADLINE_${kind.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_MS`];
	const value = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

export const CANCEL_ACK_MS = 5_000;
export const TERM_GRACE_MS = 2_000;
export const PING_INTERVAL_MS = 5_000;
export const MISSED_PONGS_LIMIT = 3;
export const READY_MS = 10_000;

/** The cancel ladder: cancel, wait 5 s for the child to settle the job, then TERM, then 2 s later KILL. */
export const CANCEL_LADDER = Object.freeze([
	{ atMs: CANCEL_ACK_MS, step: "term" as const },
	{ atMs: CANCEL_ACK_MS + TERM_GRACE_MS, step: "kill" as const },
]);

export const CRASH_LOOP_EXITS = 3;
export const CRASH_LOOP_WINDOW_MS = 5_000;
export const CRASH_LOOP_COOLDOWN_MS = 60_000;

/** Three exits within 5 s make the child `unavailable` for 60 s; within that time no spawn is attempted. */
export class CrashLoop {
	readonly #now: () => number;
	#exits: number[] = [];
	#unavailableUntil = 0;

	constructor(now: () => number) {
		this.#now = now;
	}

	recordExit(): void {
		const now = this.#now();
		this.#exits = [...this.#exits.filter((at) => now - at < CRASH_LOOP_WINDOW_MS), now];
		if (this.#exits.length >= CRASH_LOOP_EXITS) {
			this.#unavailableUntil = now + CRASH_LOOP_COOLDOWN_MS;
			this.#exits = [];
		}
	}

	unavailable(): boolean {
		return this.#now() < this.#unavailableUntil;
	}
}

/** Control liveness: a ping per interval while work exists; three unanswered pings in a row mean the child is gone. */
export class Liveness {
	#outstanding = 0;

	pingSent(): void {
		this.#outstanding += 1;
	}

	pongReceived(): void {
		this.#outstanding = 0;
	}

	unresponsive(): boolean {
		return this.#outstanding >= MISSED_PONGS_LIMIT;
	}
}
