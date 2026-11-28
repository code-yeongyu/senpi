import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { lockWithLossHandling } from "./file-lock.ts";
import { sessionIdFromFile } from "./foreign-session-holders.ts";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { assertValidSessionId } from "./session-manager.ts";
import { writeAtomic } from "./session-sidecar-store.ts";

export interface SessionRetirement {
	readonly retiredAt: string;
	readonly reason: "requested" | "takeover";
}

export class RetirementFault extends Error {
	readonly code: "session_retired" | "retirement_marker_unavailable" | "retirement_store_unavailable";
	/** What a client reads as `errorData`: files named relative to the agent dir, never by host path (senpi#7622). */
	readonly detail: Readonly<Record<string, unknown>>;
	/** The absolute store or marker path, for this host's own log only. */
	readonly path: string | undefined;
	constructor(code: RetirementFault["code"], detail: Readonly<Record<string, unknown>>, path?: string) {
		super(code);
		this.code = code;
		this.detail = detail;
		this.path = path;
	}
}

/** A failed retirement as an RPC client may read it and as this host's log keeps it: raw error text names host paths. */
export function describeRetirementFailure(cause: unknown): {
	readonly errorData: Readonly<Record<string, unknown>>;
	readonly hostLog: string;
} {
	if (!(cause instanceof RetirementFault))
		return { errorData: { detail: "retirement_write_failed" }, hostLog: String(cause) };
	const path = cause.path === undefined ? "" : ` ${cause.path}`;
	return {
		errorData: { detail: cause.code, ...cause.detail },
		hostLog: `${cause.code} ${JSON.stringify(cause.detail)}${path}`,
	};
}

const STORE = "retired-sessions";

function absent(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

/** A malformed requested id names no marker; the registry refuses it with its own typed code. */
function validId(id: string | undefined): string | undefined {
	if (id === undefined) return undefined;
	try {
		assertValidSessionId(id);
		return id;
	} catch {
		return undefined;
	}
}

/**
 * An id that is not a session id names no marker: only that identity is refused, and no path is ever built from it
 * (senpi#7622).
 */
function locations(agentDir: string, id: string) {
	if (validId(id) === undefined)
		throw new RetirementFault("retirement_marker_unavailable", { action: "repair_session_header" });
	const store = join(agentDir, STORE);
	return { store, marker: join(store, `${id}.json`), markerName: `${STORE}/${id}.json` };
}

async function syncPath(path: string): Promise<void> {
	const file = await open(path, "r");
	try {
		await file.sync();
	} finally {
		await file.close();
	}
}

export async function readSessionRetirement(agentDir: string, id: string): Promise<SessionRetirement | undefined> {
	const { store, marker, markerName } = locations(agentDir, id);
	try {
		if (!(await lstat(store)).isDirectory()) throw new Error("not a directory");
		await access(store, constants.R_OK | constants.X_OK);
	} catch (cause) {
		if (absent(cause)) return undefined;
		throw new RetirementFault(
			"retirement_store_unavailable",
			{ store: STORE, action: "repair_retirement_store" },
			store,
		);
	}
	try {
		let stat: Awaited<ReturnType<typeof lstat>>;
		try {
			stat = await lstat(marker);
		} catch (cause) {
			if (absent(cause)) return undefined;
			throw cause;
		}
		if (!stat.isFile() || stat.size > 4096) throw new Error("invalid retirement marker");
		const value: unknown = JSON.parse(await readFile(marker, "utf8"));
		if (
			typeof value !== "object" ||
			value === null ||
			!("version" in value) ||
			value.version !== 1 ||
			!("reason" in value) ||
			(value.reason !== "requested" && value.reason !== "takeover") ||
			!("retiredAt" in value) ||
			typeof value.retiredAt !== "string" ||
			new Date(value.retiredAt).toISOString() !== value.retiredAt
		)
			throw new Error("invalid retirement marker");
		return { reason: value.reason, retiredAt: value.retiredAt };
	} catch {
		throw new RetirementFault(
			"retirement_marker_unavailable",
			{ marker: markerName, action: "repair_retirement_marker" },
			marker,
		);
	}
}

/** Serialize retirement and physical open for this durable identity across independent processes. */
async function lockRetirement(agentDir: string, id: string) {
	const { store, marker } = locations(agentDir, id);
	try {
		if (await mkdir(store, { mode: 0o700, recursive: true })) await syncPath(agentDir);
		const held = await lockWithLossHandling(marker, {
			realpath: false,
			retries: { retries: 10, minTimeout: 10, maxTimeout: 250 },
			// Every marker write and removal asserts the lock first, so a lost lock refuses the write; this only names it.
			onLost: () => process.stderr.write(`senpi retirement lock lost before release: ${marker}\n`),
		});
		const persist = async (retirement: SessionRetirement) => {
			held.assertHeld();
			await writeAtomic(marker, JSON.stringify({ version: 1, ...retirement }), "retirement");
			await syncPath(marker);
			await syncPath(store);
		};
		return {
			release: held.release,
			assertHeld: held.assertHeld,
			persist,
			read: () => readSessionRetirement(agentDir, id),
			clear: async () => {
				held.assertHeld();
				await unlink(marker);
				await syncPath(store);
			},
			record: async (reason: SessionRetirement["reason"]) => {
				const previous = await readSessionRetirement(agentDir, id);
				if (previous) return previous;
				const retirement = { retiredAt: new Date().toISOString(), reason };
				await persist(retirement);
				return retirement;
			},
		};
	} catch {
		throw new RetirementFault(
			"retirement_store_unavailable",
			{ store: STORE, action: "check_retirement_store_and_retry" },
			store,
		);
	}
}

/** Records retirement under the identity's lock; an identity already retired keeps its first record. */
export async function recordRetirement(agentDir: string, id: string, reason: SessionRetirement["reason"]) {
	const lock = await lockRetirement(agentDir, id);
	try {
		return await lock.record(reason);
	} finally {
		await lock.release();
	}
}

/** Retires a transcript without starting its host or loading its extensions. Does not stop a live turn. */
export async function retireSession(options: {
	readonly agentDir: string;
	readonly sessionPath?: string;
	readonly reason: SessionRetirement["reason"];
}): Promise<SessionRetirement | { readonly reason: "memory_only" }> {
	if (options.sessionPath === undefined) return { reason: "memory_only" };
	const id = await sessionIdFromFile(options.sessionPath);
	if (id === undefined) throw new Error("Retirement requires a session transcript with a durable header");
	return recordRetirement(options.agentDir, id, options.reason);
}

/** Hold the identity across physical admission and consume its marker only at the successful reply. */
export async function admitRetirement(
	agentDir: string | undefined,
	target: { readonly sessionPath?: string; readonly durableSessionId?: string },
	explicit = false,
) {
	if (!agentDir) return undefined;
	const id =
		(target.sessionPath && (await sessionIdFromFile(resolveMovedPath(target.sessionPath)))) ??
		validId(target.durableSessionId);
	if (!id) {
		// A fresh open has no identity to check yet, but may not claim a working store when the store itself is broken.
		const store = join(agentDir, STORE);
		try {
			if (!(await lstat(store)).isDirectory()) throw new Error("not a directory");
			await access(store, constants.R_OK | constants.X_OK);
		} catch (cause) {
			if (!absent(cause))
				throw new RetirementFault(
					"retirement_store_unavailable",
					{ store: STORE, action: "repair_retirement_store" },
					store,
				);
		}
		return undefined;
	}
	const lock = await lockRetirement(agentDir, id);
	try {
		const recorded = await lock.read();
		if (recorded && !explicit) throw new RetirementFault("session_retired", { ...recorded });
		let consuming = false;
		return {
			check(actualId: string | undefined) {
				lock.assertHeld();
				if (actualId && actualId !== id) throw new Error("session identity changed during retirement admission");
			},
			async consume() {
				if (!recorded) return;
				consuming = true;
				await lock.clear();
			},
			async rollback() {
				try {
					if (consuming && recorded) await lock.persist(recorded);
				} finally {
					await lock.release();
				}
			},
			release: lock.release,
		};
	} catch (cause) {
		await lock.release();
		throw cause;
	}
}
