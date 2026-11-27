import type { BigIntStats } from "node:fs";
import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import type { OpenFreeWalkIo } from "../../../../utils/paths.ts";
import {
	automountTriggerPathSync,
	RESOLUTION_TIMED_OUT,
	UNMOUNTED_AUTOMOUNT,
	withResolutionDeadline,
} from "@code-yeongyu/senpi-machine-ops";

/** How long one filesystem fact may take before it is recorded as timed out (the automount helper's deadline). */
export const PATH_FACT_DEADLINE_MS = 5000;
/** Rounds of fetching a decision's missing facts: each round can reveal one more link hop or listed directory. */
const MAX_FACT_ROUNDS = 48;

export type FactKind = "lstat" | "stat" | "readlink" | "readdir" | "realpath";
type Fact = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };

/** A probe the facts did not hold yet: thrown by a synchronous reader so its caller ends like on an I/O error. */
class FactNotFetched extends Error {
	readonly code = "EFACTPENDING";
}

const keyOf = (kind: FactKind, path: string): string => `${kind}\0${path}`;

/**
 * Filesystem answers for one permission decision (senpi#4565). The decision runs synchronously on the host thread (the
 * dispatch fence cannot yield), so it never calls the filesystem itself: it reads these facts, and a fact not fetched
 * yet throws with code `EFACTPENDING`, which every reader already treats like any I/O error (the conservative answer).
 * {@link decideWithPathFacts} fetches what a run missed, off the host thread, and runs the decision again.
 */
export class PathFacts {
	readonly #facts = new Map<string, Fact>();
	readonly #fetch: FactFetcher;

	constructor(fetch: FactFetcher = fetchFromFilesystem) {
		this.#fetch = fetch;
	}
	readonly #missing = new Map<string, { readonly kind: FactKind; readonly path: string }>();

	lstat(path: string): BigIntStats {
		return this.#read("lstat", path) as BigIntStats;
	}

	/** `lstat`, or `undefined` for a name that does not exist (`throwIfNoEntry: false`). */
	lstatIfPresent(path: string): BigIntStats | undefined {
		try {
			return this.lstat(path);
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			if (code === "ENOENT" || code === "ENOTDIR" || code === UNMOUNTED_AUTOMOUNT) return undefined;
			throw error;
		}
	}

	stat(path: string): BigIntStats {
		return this.#read("stat", path) as BigIntStats;
	}

	/** Whether `stat` answers (symlinks followed), like an `access(F_OK)` check; a pending fact answers false. */
	exists(path: string): boolean {
		try {
			this.stat(path);
			return true;
		} catch {
			return false;
		}
	}

	readlink(path: string): string {
		return this.#read("readlink", path) as string;
	}

	readdir(path: string): string[] {
		return this.#read("readdir", path) as string[];
	}

	realpath(path: string): string {
		return this.#read("realpath", path) as string;
	}

	/** The open-free walker's two calls, answered from these facts. */
	get walkIo(): OpenFreeWalkIo {
		return { lstatIsLink: (path) => this.lstat(path).isSymbolicLink(), readlink: (path) => this.readlink(path) };
	}

	/** Whether the last run read a fact that was not fetched yet. */
	get incomplete(): boolean {
		return this.#missing.size > 0;
	}

	#read(kind: FactKind, path: string): unknown {
		if (automountTriggerPathSync(path) !== undefined)
			throw Object.assign(new Error(`${UNMOUNTED_AUTOMOUNT}: ${path}`), { code: UNMOUNTED_AUTOMOUNT, path });
		const fact = this.#facts.get(keyOf(kind, path));
		if (fact === undefined) {
			this.#missing.set(keyOf(kind, path), { kind, path });
			throw new FactNotFetched(`fact not fetched yet: ${kind} ${path}`);
		}
		if (fact.ok) return fact.value;
		throw Object.assign(new Error(`${fact.code}: ${kind} ${path}`), { code: fact.code, path });
	}

	/** Fetch every fact the last run missed, each bounded by {@link PATH_FACT_DEADLINE_MS}. */
	async fetchMissing(deadlineMs = PATH_FACT_DEADLINE_MS): Promise<void> {
		const wanted = [...this.#missing.entries()];
		this.#missing.clear();
		await Promise.all(
			wanted.map(async ([key, { kind, path }]) => {
				this.#facts.set(key, await boundedFact(this.#fetch(kind, path), deadlineMs));
			}),
		);
	}
}

/** Where a fact comes from: the filesystem, or a stand-in that tests make block or fail. */
export type FactFetcher = (kind: FactKind, path: string) => Promise<unknown>;

const fetchFromFilesystem: FactFetcher = (kind, path) =>
	kind === "lstat"
		? lstat(path, { bigint: true })
		: kind === "stat"
			? stat(path, { bigint: true })
			: kind === "readlink"
				? readlink(path)
				: kind === "readdir"
					? readdir(path)
					: realpath(path);

async function boundedFact(io: Promise<unknown>, deadlineMs: number): Promise<Fact> {
	try {
		const value = await withResolutionDeadline(io, deadlineMs);
		return value === RESOLUTION_TIMED_OUT ? { ok: false, code: "ETIMEDOUT" } : { ok: true, value };
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		return { ok: false, code: typeof code === "string" ? code : "EIO" };
	}
}

/**
 * Run a synchronous decision until it no longer reads a fact that was not fetched: each round fetches what the last
 * one missed, off the host thread. Past {@link MAX_FACT_ROUNDS} rounds the last answer stands, which is the
 * conservative one, since every unfetched fact reads as an I/O error.
 */
export async function decideWithPathFacts<T>(decide: (facts: PathFacts) => T, facts = new PathFacts()): Promise<T> {
	// A reader may rethrow a pending fact (a probe whose every error blocks the call): that run is retried too.
	const run = (): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown } => {
		try {
			return { ok: true, value: decide(facts) };
		} catch (error) {
			return { ok: false, error };
		}
	};
	let answer = run();
	for (let round = 0; facts.incomplete && round < MAX_FACT_ROUNDS; round += 1) {
		await facts.fetchMissing();
		answer = run();
	}
	if (!answer.ok) throw answer.error;
	return answer.value;
}

/** The pending-fact code {@link PathFacts} readers throw; never an answer about the path itself. */
export const FACT_PENDING = "EFACTPENDING";

let active: PathFacts | undefined;

/** Run a synchronous section (it must not await) with `facts` as the ones its path probes read. */
export function withPathFacts<T>(facts: PathFacts, run: () => T): T {
	const previous = active;
	active = facts;
	try {
		return run();
	} finally {
		active = previous;
	}
}

/**
 * The facts of the section running now. Outside {@link withPathFacts} nothing was prefetched, so every probe reads as
 * pending (the conservative answer) and nothing touches the filesystem on the host thread.
 */
export function currentPathFacts(): PathFacts {
	return active ?? new PathFacts();
}
