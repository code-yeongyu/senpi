import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolveMovedPath } from "./extensions/builtin/moved-path-guard/resolve.ts";
import { errorCode } from "./extensions/builtin/terminal/lease-file.ts";
import { liveSessionHolders, type SessionHolder, type SessionHolderProbes } from "./session-holders.ts";
import { parseEntryLine } from "./session-record.ts";

/** Read only the header, asynchronously: checking admission must not load or mutate a transcript. */
async function sessionIdFromFile(sessionFile: string): Promise<string | undefined> {
	try {
		// Admission must not consume a pipe: its reader belongs to the session runtime.
		if (!(await stat(sessionFile)).isFile()) return undefined;
		const stream = createReadStream(sessionFile, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		try {
			for await (const line of lines) {
				const entry = parseEntryLine(line);
				if (entry === null) continue;
				return entry.type === "session" && typeof entry.id === "string" ? entry.id : undefined;
			}
			return undefined;
		} finally {
			lines.close();
			stream.destroy();
		}
	} catch (cause) {
		// A path that does not yet exist is a new session, not a held resume.
		if (errorCode(cause) === "ENOENT") return undefined;
		throw cause;
	}
}

/** Fresh lease evidence for each admission; a clean exit or stale identity clears the next retry. */
export async function foreignSessionHolders(
	sessionFile: string | undefined,
	sessionId?: string,
	probes?: SessionHolderProbes,
): Promise<SessionHolder[]> {
	if (sessionFile === undefined) return [];
	const path = resolveMovedPath(sessionFile);
	const id = sessionId ?? (await sessionIdFromFile(path));
	if (id === undefined) return [];
	// Both runtimes currently use this PID: the session-worker is a worker_threads Worker,
	// not a subprocess. Do not exclude arbitrary descendants or holder-supplied host identities.
	return (await liveSessionHolders(path, id, probes)).filter((holder) => holder.pid !== process.pid);
}

/** One terminal-safe line; cwd can contain newlines or escape sequences. */
export function describeSessionHolders(holders: readonly SessionHolder[]): string {
	return holders
		.map(({ pid, cwd }) => `pid ${pid}${cwd === undefined ? "" : ` in ${JSON.stringify(cwd)}`}`)
		.join("; ");
}

export const SESSION_HOLDER_LOOKUP_FAILED = "Unable to inspect session holders; continuing without holder information.";

/** Live foreign holders of `sessionFile` before an interactive resume switches onto it; a failed lookup stays advisory. */
export async function checkSessionHolders(
	sessionFile: string,
): Promise<{ readonly holders: readonly SessionHolder[] } | { readonly lookupFailed: true }> {
	try {
		return { holders: await foreignSessionHolders(sessionFile, undefined, { markUnproven: true }) };
	} catch {
		return { lookupFailed: true };
	}
}

const HOLDER_EXIT_POLL_MS = 100;

/**
 * Why taking over is not offered, or `undefined` when it is: a holder whose identity is unverified could be a
 * reused pid, and a holder inside a multi-session host would take every other session of that host down with it.
 */
export function takeOverRefusal(holders: readonly SessionHolder[]): string | undefined {
	if (holders.some((holder) => holder.host_instance !== undefined))
		return "It is open in a multi-session host; close it there, then /resume again.";
	if (holders.some((holder) => holder.unproven === true))
		return "The other process could not be verified; quit it there, then /resume again.";
	return undefined;
}

/**
 * Explicit take-over of a session another live process holds (senpi#5744). The holder set is read again right
 * before signalling and intersected with the pids the person confirmed; only verified, single-session holders are
 * asked to exit (SIGTERM). Then it waits until none of them holds the file. Returns false when a confirmed holder
 * can no longer be signalled safely or is still there at the deadline.
 */
export async function stopSessionHolders(
	sessionFile: string,
	confirmed: readonly SessionHolder[],
	timeoutMs = 10_000,
): Promise<boolean> {
	const confirmedPids = new Set(confirmed.map(({ pid }) => pid));
	const current = (await foreignSessionHolders(sessionFile, undefined, { markUnproven: true })).filter(({ pid }) =>
		confirmedPids.has(pid),
	);
	if (takeOverRefusal(current) !== undefined) return false;
	for (const { pid } of current) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (cause) {
			if (errorCode(cause) !== "ESRCH") throw cause;
		}
	}
	const stopping = new Set(current.map(({ pid }) => pid));
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const left = (await foreignSessionHolders(sessionFile)).filter(({ pid }) => stopping.has(pid));
		if (left.length === 0) return true;
		if (Date.now() >= deadline) return false;
		// A foreign process offers no exit event to await; its holder record is the only signal.
		await new Promise((resolve) => setTimeout(resolve, HOLDER_EXIT_POLL_MS));
	}
}

/** The post-switch advisory line, or `undefined` when no other process holds the session. */
export async function sessionHolderWarning(
	sessionFile: string | undefined,
	sessionId?: string,
): Promise<string | undefined> {
	let holders: SessionHolder[];
	try {
		holders = await foreignSessionHolders(sessionFile, sessionId);
	} catch {
		return SESSION_HOLDER_LOOKUP_FAILED;
	}
	if (holders.length === 0) return undefined;
	return `This session is also open in another process (${describeSessionHolders(holders)}). Concurrent writes may corrupt its history; quit the other process before continuing.`;
}
