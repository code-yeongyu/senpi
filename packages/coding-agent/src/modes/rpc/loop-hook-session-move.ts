import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { isBoolean, isOptional, isRecord, isString, loopHookFamily, malformed } from "./loop-hook-payloads.ts";

// A hosted loop's session move (senpi#5898). The move's state folder lives where the loop runs, so it crosses the
// link as a list of entries: a directory (`{ path }`) or a file (`{ path, data }`, base64), each path relative and
// `/`-separated, in any order (a file's folders are created with it). Export runs the user's handlers on a fresh folder
// of this machine and returns what they wrote (`files`); import writes the carried entries into a fresh folder and runs
// the handlers on it. Either folder is removed when the call ends. A handler failure is reported in the reply's
// `errors`, which refuses the move (export) or keeps the state for the next open (import), as a session's move does.
// The state is bounded both ways by `MOVE_STATE_LIMITS`: an import past them is refused before anything is written,
// and an export past them fails the call (so the move is refused) instead of sending what the link cannot carry.

/** One entry of a carried state folder. */
interface CarriedStateEntry {
	readonly path: string;
	readonly data?: string;
}

/** The decoded bytes one carried file, and one carried state folder in total, may hold. */
const MOVE_STATE_LIMITS = { fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 } as const;

/** A relative path that stays inside its folder: no empty, `.` or `..` segment, not absolute. */
const isInsidePath = (path: string): boolean =>
	path.length > 0 &&
	!path.startsWith("/") &&
	!path.includes("\\") &&
	path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The decoded size of canonical base64 `data`, or `undefined` when it is not canonical base64. */
function decodedBytes(data: string): number | undefined {
	if (data.length % 4 !== 0) return undefined;
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	const bytes = (data.length / 4) * 3 - padding;
	// The size is known from the length alone, so an oversize file is refused before its characters are scanned.
	return bytes > MOVE_STATE_LIMITS.fileBytes || BASE64.test(data) ? bytes : undefined;
}

/** The carried entries, refused whole when one is malformed or the state passes `MOVE_STATE_LIMITS`. */
function carriedStateOf(files: unknown): CarriedStateEntry[] {
	if (!Array.isArray(files)) throw malformed("session_move_import");
	const entries: CarriedStateEntry[] = [];
	let total = 0;
	for (const entry of files) {
		if (!isRecord(entry) || !isString(entry.path) || !isInsidePath(entry.path) || !isOptional(entry.data, isString))
			throw malformed("session_move_import");
		const { path, data } = entry;
		if (data === undefined) {
			entries.push({ path });
			continue;
		}
		const bytes = decodedBytes(data);
		total += bytes ?? 0;
		if (bytes === undefined || bytes > MOVE_STATE_LIMITS.fileBytes || total > MOVE_STATE_LIMITS.totalBytes)
			throw malformed("session_move_import");
		entries.push({ path, data });
	}
	return entries;
}

/** Every entry under `dir`, parents before children; a symlink or other special file has no carried form. */
async function readEntries(dir: string, budget = { total: 0 }, prefix = ""): Promise<CarriedStateEntry[]> {
	const entries: CarriedStateEntry[] = [];
	for (const dirent of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = prefix === "" ? dirent.name : posix.join(prefix, dirent.name);
		if (dirent.isDirectory()) entries.push({ path }, ...(await readEntries(dir, budget, path)));
		else if (dirent.isFile()) {
			const bytes = await readFile(join(dir, path));
			budget.total += bytes.length;
			if (bytes.length > MOVE_STATE_LIMITS.fileBytes || budget.total > MOVE_STATE_LIMITS.totalBytes)
				throw new Error(`session_move_export state is past the carried limits at ${path}`);
			entries.push({ path, data: bytes.toString("base64") });
		} else throw new Error(`session_move_export state has no carried form at ${path}: only folders and files travel`);
	}
	return entries;
}

async function inFreshFolder<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-move-state-"));
	try {
		return await run(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

export const SESSION_MOVE_LOOP_HOOKS = loopHookFamily({
	session_move_export: ({ moveId }) => {
		if (!isString(moveId)) throw malformed("session_move_export");
		return {
			emit: ({ runner, only }) =>
				inFreshFolder(async (dir) => {
					// Its failures reach the reply's `errors` through the runner's error listener, as every handler's do.
					await runner.emitSessionMove({ type: "session_move_export", moveId, dir }, only);
					return { files: await readEntries(dir) };
				}),
		};
	},
	session_move_import: ({ moveId, redelivered, files }) => {
		if (!isString(moveId) || !isBoolean(redelivered)) throw malformed("session_move_import");
		const entries = carriedStateOf(files);
		return {
			emit: ({ runner, only }) =>
				inFreshFolder(async (dir) => {
					for (const { path, data } of entries) {
						const target = join(dir, path);
						if (data === undefined) await mkdir(target, { recursive: true });
						else {
							await mkdir(dirname(target), { recursive: true });
							await writeFile(target, Buffer.from(data, "base64"));
						}
					}
					const event = { type: "session_move_import" as const, moveId, dir, redelivered };
					await runner.emitSessionMove(event, only);
					return undefined;
				}),
		};
	},
});
