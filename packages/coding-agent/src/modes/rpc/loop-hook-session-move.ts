import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { isBoolean, isOptional, isRecord, isString, loopHookFamily, malformed } from "./loop-hook-payloads.ts";

// A hosted loop's session move (senpi#5898). The move's state folder lives where the loop runs, so it crosses the
// link as a list of entries: a directory (`{ path }`) or a file (`{ path, data }`, base64), each path relative and
// `/`-separated. Export runs the user's handlers on a fresh folder of this machine and returns what they wrote
// (`files`); import writes the carried entries into a fresh folder and runs the handlers on it. Either folder is
// removed when the call ends. A handler failure is reported in the reply's `errors`, which refuses the move (export)
// or keeps the state for the next open (import), as a session's move does.

/** One entry of a carried state folder. */
export interface CarriedStateEntry {
	readonly path: string;
	readonly data?: string;
}

/** A relative path that stays inside its folder: no empty, `.` or `..` segment, not absolute. */
const isInsidePath = (path: string): boolean =>
	path.length > 0 &&
	!path.startsWith("/") &&
	!path.includes("\\") &&
	path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

const isEntry = (value: unknown): value is CarriedStateEntry =>
	isRecord(value) && isString(value.path) && isInsidePath(value.path) && isOptional(value.data, isString);

/** Every entry under `dir`, parents before children; a symlink or other special file has no carried form. */
async function readEntries(dir: string, prefix = ""): Promise<CarriedStateEntry[]> {
	const entries: CarriedStateEntry[] = [];
	for (const dirent of (await readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = prefix === "" ? dirent.name : posix.join(prefix, dirent.name);
		if (dirent.isDirectory()) entries.push({ path }, ...(await readEntries(dir, path)));
		else if (dirent.isFile()) entries.push({ path, data: (await readFile(join(dir, path))).toString("base64") });
		else throw new Error(`session_move_export state has no carried form at ${path}: only folders and files travel`);
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
		if (!isString(moveId) || !isBoolean(redelivered) || !Array.isArray(files) || !files.every(isEntry))
			throw malformed("session_move_import");
		return {
			emit: ({ runner, only }) =>
				inFreshFolder(async (dir) => {
					for (const { path, data } of files) {
						if (data === undefined) await mkdir(join(dir, path), { recursive: true });
						else await writeFile(join(dir, path), Buffer.from(data, "base64"));
					}
					const event = { type: "session_move_import" as const, moveId, dir, redelivered };
					await runner.emitSessionMove(event, only);
					return undefined;
				}),
		};
	},
});
