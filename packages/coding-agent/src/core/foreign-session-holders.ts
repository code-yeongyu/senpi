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
		return { holders: await foreignSessionHolders(sessionFile) };
	} catch {
		return { lookupFailed: true };
	}
}

const HOLDER_EXIT_POLL_MS = 100;

/**
 * Explicit take-over of a session another live process holds (senpi#5744): ask each holder to exit with SIGTERM
 * and wait until none of them holds the file any more. A holder record is only reported live after its process
 * identity was validated, so the signal never reaches a reused pid. Returns false when a holder is still there
 * at the deadline.
 */
export async function stopSessionHolders(
	sessionFile: string,
	holders: readonly SessionHolder[],
	timeoutMs = 10_000,
): Promise<boolean> {
	for (const { pid } of holders) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (cause) {
			if (errorCode(cause) !== "ESRCH") throw cause;
		}
	}
	const stopping = new Set(holders.map(({ pid }) => pid));
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
