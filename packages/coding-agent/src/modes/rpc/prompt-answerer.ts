/**
 * senpi#7572: a run's prompts (its dialogs and questions) are answered only by its designated answerer.
 *
 * Opening a new run mints a 32-byte answer key, returned once, in the opener's `open_session` reply. The host keeps only
 * its SHA-256 digest, in memory: never in a file, the environment, a log, a list row or a message to a worker, so a
 * process the run's own tools start cannot read it. The opener's connection is the answerer; another connection becomes
 * one by presenting the key on `attach_session`, and a single answer may carry it (`extension_ui_response.answerKey`,
 * for a relay or a generation route). A connection answers only while it is attached. A run reopened by the host itself
 * (a handover restore) has no key and no answerer.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PROMPT_ANSWERER_CAPABILITY = "prompt_answerer";
export const RPC_ERROR_PROMPT_ANSWERER_REQUIRED = "prompt_answerer_required";

/**
 * Whether a run asks for a designated answerer when its `open_session` does not say (`designatedAnswerer`). The one
 * place the cutover default lives.
 */
export const DESIGNATED_ANSWERER_BY_DEFAULT = false;

/** The answerer of a host with no per-connection identity (stdio): its one client opened every run. */
const SOLE_CLIENT = "\u0000sole-client";

/** Why a run that asked for the rule has no answerer at all: the host reopened it after a handover. */
export type AnswererUnavailable = "host_handover";

interface Run {
	/** Absent for a run the host reopened on its own: nobody holds a key for it. */
	readonly digest: Buffer | undefined;
	readonly designated: Set<string>;
	readonly unavailable?: AnswererUnavailable;
}

function digestOf(key: string): Buffer {
	return createHash("sha256").update(key, "utf8").digest();
}

export class PromptAnswerers {
	private readonly runs = new Map<string, Run>();
	/** A key minted at the opener's attach, held until that open's reply takes it; never serialized. */
	private readonly minted = new Map<string, string>();

	/** Whether a key minted for this run waits for its open's reply. */
	hasMinted(sessionId: string): boolean {
		return this.minted.has(sessionId);
	}

	/** The key minted for this run, handed to its open's reply once. */
	takeMinted(sessionId: string): string | undefined {
		const key = this.minted.get(sessionId);
		this.minted.delete(sessionId);
		return key;
	}

	/**
	 * A new run of `sessionId`, opened by `opener`. Returns the run's key, which only the opener's reply carries, or
	 * undefined when the run takes answers from any client (`designatedAnswerer: false`).
	 */
	open(
		sessionId: string,
		opener: string | undefined,
		designated = DESIGNATED_ANSWERER_BY_DEFAULT,
	): string | undefined {
		this.minted.delete(sessionId);
		if (!designated) {
			this.runs.delete(sessionId);
			return undefined;
		}
		const key = randomBytes(32).toString("base64url");
		this.runs.set(sessionId, { digest: digestOf(key), designated: new Set([opener ?? SOLE_CLIENT]) });
		this.minted.set(sessionId, key);
		return key;
	}

	/** A run that asked for the rule, reopened by the host after a handover: no key exists, so no client answers it. */
	openAfterHandover(sessionId: string): void {
		this.runs.set(sessionId, { digest: undefined, designated: new Set(), unavailable: "host_handover" });
	}

	/** Why nobody can answer this run, when that is the case. */
	unavailable(sessionId: string): AnswererUnavailable | undefined {
		return this.runs.get(sessionId)?.unavailable;
	}

	/** Whether `key` is this run's key. A run without a key, or a missing or malformed key, never matches. */
	private matches(run: Run, key: unknown): boolean {
		if (run.digest === undefined || typeof key !== "string" || key.length === 0) return false;
		return timingSafeEqual(run.digest, digestOf(key));
	}

	/** Designates `connection` when it presents the run's key; the result says whether it is an answerer now. */
	present(sessionId: string, connection: string | undefined, key: unknown, attached: boolean): boolean {
		const run = this.runs.get(sessionId);
		if (run === undefined) return true;
		if (this.matches(run, key)) run.designated.add(connection ?? SOLE_CLIENT);
		return this.isAnswerer(sessionId, connection, attached);
	}

	/** Whether `connection`, attached as `attached` says, answers this run; a run without the rule takes any answer. */
	isAnswerer(sessionId: string, connection: string | undefined, attached: boolean): boolean {
		const run = this.runs.get(sessionId);
		if (run === undefined) return true;
		return attached && run.designated.has(connection ?? SOLE_CLIENT);
	}

	/** Whether one answer is admitted: from an attached answerer, or carrying the run's key. */
	admits(sessionId: string, connection: string | undefined, attached: boolean, key: unknown): boolean {
		const run = this.runs.get(sessionId);
		if (run === undefined) return true;
		return this.isAnswerer(sessionId, connection, attached) || this.matches(run, key);
	}

	/** Whether the run requires a designated answerer and one of `attachedConnections` is it. */
	answererAttached(sessionId: string, attachedConnections: Iterable<string | undefined>): boolean {
		const run = this.runs.get(sessionId);
		if (run === undefined) return true;
		for (const connection of attachedConnections) if (run.designated.has(connection ?? SOLE_CLIENT)) return true;
		return false;
	}

	/** The connection's socket is gone: it is nobody's answerer any more, and a reconnect presents the key. */
	forgetConnection(connection: string): void {
		for (const run of this.runs.values()) run.designated.delete(connection);
	}

	forgetSession(sessionId: string): void {
		this.minted.delete(sessionId);
		this.runs.delete(sessionId);
	}
}
