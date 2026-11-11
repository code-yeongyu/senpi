/**
 * The repository identity a caller reads BEFORE it releases a session (senpi#6435), in the two forms `move_session`
 * op `identity` answers. Both are read-only: they open, claim, seal and rewrite nothing, and touch no move record.
 *
 * The session form takes a path from the caller, so its reach is bounded. It reads a session file of THIS host's own
 * session folder and nothing else (the path is resolved first, so a link that leaves that folder is refused without
 * being opened, and the open itself follows no link and blocks on no pipe); it scans at most `SCAN_LIMIT_BYTES`; it
 * answers the recorded repository identity and no other entry of the file; and every path it will not read answers
 * ONE refusal, so the answer never tells a caller which paths exist. It is the value `export` writes into its bundle
 * manifest, read the same way: the last `repository-identity` entry of the file wins.
 *
 * The folder form answers a working folder's own git identity through `readRepositoryIdentity`, the read `import`
 * already makes on the folder a caller names, so it reaches no further than the import that same caller can send. It
 * has no refusal of its own: a folder with no repository, one that is not there, and one that cannot be read all
 * answer "no repository", so it never says which folders exist.
 */
import { constants } from "node:fs";
import { type FileHandle, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import {
	parseRepositoryIdentity,
	REPOSITORY_IDENTITY_ENTRY_TYPE,
	type RepositoryIdentity,
} from "../repository-identity.ts";

/** At most this many bytes of a session file are scanned; a larger file is refused rather than answered in part. */
export const SCAN_LIMIT_BYTES = 1024 ** 3;
/** A recorded identity is a few hundred bytes, so a longer line is not one and is never held in memory. */
const MAX_LINE_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;
/** The entry type as it appears in the file's bytes, so only a line that could carry an identity is parsed. */
const MARKER = Buffer.from(JSON.stringify(REPOSITORY_IDENTITY_ENTRY_TYPE));
// A link is resolved before the open, so these only close the gap between that resolution and the open itself.
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** The one answer for every path this host will not read, so a refusal never says whether a file is there. */
export class MoveIdentityUnreadableError extends Error {
	constructor() {
		super("No session file of this device is at that path, or it cannot be read; nothing was read.");
		this.name = "MoveIdentityUnreadableError";
	}
}

export class MoveIdentityTooLargeError extends Error {
	constructor() {
		super(
			`This session file is larger than the ${SCAN_LIMIT_BYTES} bytes this read scans, so its recorded repository was not read. The move can still be sent without the check.`,
		);
		this.name = "MoveIdentityTooLargeError";
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parsed(line: Buffer): unknown {
	try {
		return JSON.parse(line.toString("utf8"));
	} catch {
		return undefined;
	}
}

function isSessionHeader(line: Buffer): boolean {
	const entry = parsed(line);
	return isRecord(entry) && entry.type === "session" && typeof entry.id === "string";
}

function identityIn(line: Buffer): RepositoryIdentity | undefined {
	if (line.indexOf(MARKER) === -1) return undefined;
	const entry = parsed(line);
	if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== REPOSITORY_IDENTITY_ENTRY_TYPE)
		return undefined;
	return parseRepositoryIdentity(entry.data);
}

/**
 * Reads the file one bounded line at a time: the first line must be the session header, and only a line carrying the
 * entry type is parsed, so a transcript of any shape costs one pass and a constant amount of memory.
 */
async function scan(handle: FileHandle): Promise<RepositoryIdentity | undefined> {
	const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
	let carry: Buffer[] = [];
	let carried = 0;
	let dropping = false;
	let header = false;
	let recorded: RepositoryIdentity | undefined;
	let position = 0;
	const take = (line: Buffer): void => {
		if (header) recorded = identityIn(line) ?? recorded;
		else if (line.length > 0) {
			if (!isSessionHeader(line)) throw new MoveIdentityUnreadableError();
			header = true;
		}
	};
	for (;;) {
		const { bytesRead } = await handle.read(chunk, 0, CHUNK_BYTES, position);
		if (bytesRead === 0) break;
		position += bytesRead;
		if (position > SCAN_LIMIT_BYTES) throw new MoveIdentityTooLargeError();
		const data = chunk.subarray(0, bytesRead);
		let start = 0;
		for (;;) {
			const newline = data.indexOf(NEWLINE, start);
			if (newline === -1) {
				const rest = data.subarray(start);
				// Once a line is too long to be an identity, the rest of it is dropped too: it is never held in memory.
				if (dropping || carried + rest.length > MAX_LINE_BYTES) {
					carry = [];
					carried = 0;
					dropping = true;
				} else if (rest.length > 0) {
					carry.push(Buffer.from(rest));
					carried += rest.length;
				}
				break;
			}
			const piece = data.subarray(start, newline);
			start = newline + 1;
			if (dropping) {
				dropping = false;
				carry = [];
				carried = 0;
				if (!header) throw new MoveIdentityUnreadableError();
				continue;
			}
			const line = carried === 0 ? piece : Buffer.concat([...carry, piece]);
			carry = [];
			carried = 0;
			take(line);
		}
	}
	if (carried > 0 && !dropping) take(Buffer.concat(carry));
	if (!header) throw new MoveIdentityUnreadableError();
	return recorded;
}

/** `<sessionsRoot>/<folder>/<name>.jsonl` and nothing else, decided on the resolved path before anything is opened. */
async function sessionFileInside(sessionsRoot: string, sessionPath: string): Promise<string> {
	const [root, file] = await Promise.all([
		realpath(resolvePath(sessionsRoot)),
		realpath(resolvePath(sessionPath)),
	]).catch(() => {
		throw new MoveIdentityUnreadableError();
	});
	if (!file.endsWith(".jsonl") || dirname(dirname(file)) !== root) throw new MoveIdentityUnreadableError();
	return file;
}

export async function readSessionRepositoryIdentity(
	sessionsRoot: string,
	sessionPath: string,
): Promise<RepositoryIdentity | undefined> {
	const file = await sessionFileInside(sessionsRoot, sessionPath);
	const handle = await open(file, READ_FLAGS).catch(() => {
		throw new MoveIdentityUnreadableError();
	});
	try {
		if (!(await handle.stat()).isFile()) throw new MoveIdentityUnreadableError();
		return await scan(handle);
	} catch (cause) {
		if (cause instanceof MoveIdentityTooLargeError || cause instanceof MoveIdentityUnreadableError) throw cause;
		throw new MoveIdentityUnreadableError();
	} finally {
		await handle.close();
	}
}
