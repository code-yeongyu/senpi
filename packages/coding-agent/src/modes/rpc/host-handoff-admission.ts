/**
 * The handoff ADMISSION, decided by the host that would be replaced (senpi#7044).
 *
 * The older-engine refusal of senpi#7018 ran only in the requester, so a client released before it took a newer
 * host with a plain `host handoff`: it brought its own successor up, renamed it over the public socket and sent
 * SIGUSR1, and the incumbent drained without a say. Two records give the incumbent that say:
 *
 * - `admit_handoff { successor_engine, allow_downgrade? }` asks before any successor is spawned. This host compares
 *   the successor's engine with its own, in senpi CalVer only: a strictly older successor is refused `older_engine`,
 *   a pair that cannot be ordered (an ordinal outside CalVer, or no engine stated) `unordered_engine`.
 *   `allow_downgrade` is the operator's override; it is admitted and written to the host log naming both engines.
 * - `drain_for_handoff { admission_id }` is the drain request itself. It is honoured only for the admission this
 *   host granted, on the connection it granted it on.
 *
 * The drain PRESENTS the admission instead of consuming a grant by signal, because a signal carries nothing: SIGUSR1
 * cannot say which admission it acts on, lands on the supervisor rather than on the host that admitted, and would
 * need a grant that outlives a successor's whole start. The admitting connection is the binding: it reaches the very
 * process that admitted even after the public name moved to the successor, and the grant ends with it, so a
 * requester that gave up or died leaves nothing behind. One drain uses the grant up.
 *
 * A host that answers these records advertises `handoff_admission` and no longer `generation_handoff`, the one
 * capability a pre-fix client consults before it spawns a successor or signals: such a client attaches instead.
 */
import { randomUUID } from "node:crypto";
import {
	type EngineBuildIdentity,
	engineIdentityOf,
	engineSuccessionRefusal,
} from "../../core/engine-build-identity.ts";
import { parseEngineOrdinal } from "./host-protocol-info.ts";

export const ADMIT_HANDOFF_COMMAND = "admit_handoff";
export const DRAIN_FOR_HANDOFF_COMMAND = "drain_for_handoff";

/**
 * How long an unused admission stays valid on its open connection: longer than the 180 s a successor is given to
 * become ready (`STARTUP_DECISION_BUDGET_MS`), so the grant outlives the start it admitted and nothing longer.
 */
export const HANDOFF_ADMISSION_TTL_MS = 300_000;

export interface HandoffAdmissionHooks {
	/** This host's own engine: the side every successor is compared with. */
	readonly engine: () => EngineBuildIdentity;
	/** Starts the drain; called once per presented admission, after its answer is delivered. */
	readonly drain: () => void;
	readonly log: (line: string) => void;
}

interface Grant {
	readonly id: string;
	readonly expiresAt: number;
}

export class HostHandoffAdmissions {
	private readonly hooks: HandoffAdmissionHooks;
	/** One grant per connection: asking again on a connection replaces what it was granted before. */
	private readonly grants = new Map<string, Grant>();

	constructor(hooks: HandoffAdmissionHooks) {
		this.hooks = hooks;
	}

	/** The answer to an `admit_handoff` record received on `connection`. */
	admit(record: Readonly<Record<string, unknown>>, connection: string): Record<string, unknown> {
		const allowDowngrade = record.allow_downgrade;
		if (allowDowngrade !== undefined && typeof allowDowngrade !== "boolean") {
			return answer(record, { refused: "invalid_request", detail: "allow_downgrade must be a boolean" });
		}
		const running = this.hooks.engine();
		const successor = parseSuccessorEngine(record.successor_engine);
		const refusal =
			successor === undefined
				? ({
						reason: "unordered_engine",
						detail: `the requester stated no successor engine, so it cannot be ordered against the running host's ${describeEngine(running)}`,
					} as const)
				: engineSuccessionRefusal(successor, running);
		if (refusal !== undefined && allowDowngrade !== true) {
			this.hooks.log(`handoff admission refused (${refusal.reason}): ${refusal.detail}`);
			return answer(record, { refused: refusal.reason, detail: refusal.detail });
		}
		const grant = { id: randomUUID(), expiresAt: Date.now() + HANDOFF_ADMISSION_TTL_MS };
		this.grants.set(connection, grant);
		const engines = `successor engine ${successor === undefined ? "unstated" : describeEngine(successor)} replaces this host's ${describeEngine(running)}`;
		this.hooks.log(
			allowDowngrade === true
				? `handoff admitted by allow_downgrade (${refusal === undefined ? "no refusal to override" : `overriding ${refusal.reason}`}): ${engines} (admission ${grant.id})`
				: `handoff admitted: ${engines} (admission ${grant.id})`,
		);
		return answer(record, { admission_id: grant.id, expires_in_ms: HANDOFF_ADMISSION_TTL_MS });
	}

	/**
	 * Answers a `drain_for_handoff` record through `deliver`, then starts the drain when the record presented the live
	 * admission of its own connection. The answer goes first: a host with nothing open leaves the moment it drains.
	 */
	async drain(
		record: Readonly<Record<string, unknown>>,
		connection: string,
		deliver: (answer: object) => Promise<void>,
	): Promise<void> {
		const grant = this.grants.get(connection);
		const presented = record.admission_id;
		if (grant === undefined || presented !== grant.id || Date.now() >= grant.expiresAt) {
			this.hooks.log("drain_for_handoff refused: it presents no live admission of its connection; still serving");
			await deliver(
				answer(record, {
					refused: "unknown_admission",
					detail: "this connection holds no live admission with that id; ask admit_handoff again",
				}),
			);
			return;
		}
		this.grants.delete(connection);
		this.hooks.log(`draining for the admitted handoff ${grant.id}`);
		await deliver(answer(record, { draining: true }));
		this.hooks.drain();
	}

	/** A connection that ended takes its admission with it. */
	release(connection: string): void {
		this.grants.delete(connection);
	}
}

/** What a host that cannot hand off answers to either record: there is no drain to admit. */
export function handoffUnsupportedAnswer(record: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return answer(record, { refused: "handoff_unsupported", detail: "this host cannot drain into a successor" });
}

/** Answered with `success: true` whatever the verdict, like `begin_handover`: a client reads one `data` shape. */
function answer(record: Readonly<Record<string, unknown>>, data: Record<string, unknown>): Record<string, unknown> {
	return {
		...(typeof record.id === "string" && { id: record.id }),
		type: "response",
		command: record.type,
		success: true,
		data,
	};
}

function parseSuccessorEngine(value: unknown): EngineBuildIdentity | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const text: unknown = Reflect.get(value, "text");
	const ordinal = parseEngineOrdinal(Reflect.get(value, "ordinal"));
	return typeof text === "string" && ordinal !== undefined ? engineIdentityOf(text, ordinal) : undefined;
}

function describeEngine(engine: EngineBuildIdentity): string {
	return `${engine.text} [${engine.ordinal.join(",")}]`;
}
