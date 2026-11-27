/**
 * senpi's index of what it moved to the trash: one JSON file per entry under `<agentDir>/trash/entries/`,
 * so concurrent sessions never contend for one file. The OS trash stays the home of the data; an entry
 * whose trashed item is gone (restored or emptied from a file manager) is dropped when listed.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode } from "./trash-error.ts";

export type TrashBackend = "freedesktop" | "macos";

export interface TrashEntry {
	readonly id: string;
	readonly backend: TrashBackend;
	readonly originalPath: string;
	readonly trashedPath: string;
	/** freedesktop only: the `.trashinfo` file that names the original path. */
	readonly infoPath: string | null;
	readonly deletedAt: number;
	readonly bytes: number;
	readonly sessionId: string | null;
	readonly reason: string;
}

const ENTRY_ID = /^tr_[0-9a-z]+_[0-9a-f]{8}$/;

export function entriesDir(agentDir: string): string {
	return join(agentDir, "trash", "entries");
}

export function newEntryId(now: number): string {
	return `tr_${now.toString(36)}_${randomBytes(4).toString("hex")}`;
}

export function isEntryId(value: string): boolean {
	return ENTRY_ID.test(value);
}

export async function writeEntry(agentDir: string, entry: TrashEntry): Promise<void> {
	const dir = entriesDir(agentDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, `${entry.id}.json`);
	const staging = `${file}.${process.pid}.tmp`;
	await writeFile(staging, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(staging, file);
}

export async function removeEntry(agentDir: string, id: string): Promise<void> {
	await rm(join(entriesDir(agentDir), `${id}.json`), { force: true });
}

function parseEntry(text: string): TrashEntry | undefined {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null) return undefined;
	const field = (key: string): unknown => Reflect.get(value, key);
	const id = field("id");
	const backend = field("backend");
	const originalPath = field("originalPath");
	const trashedPath = field("trashedPath");
	const infoPath = field("infoPath");
	const deletedAt = field("deletedAt");
	const bytes = field("bytes");
	const sessionId = field("sessionId");
	const reason = field("reason");
	if (
		typeof id !== "string" ||
		!isEntryId(id) ||
		(backend !== "freedesktop" && backend !== "macos") ||
		typeof originalPath !== "string" ||
		typeof trashedPath !== "string" ||
		(infoPath !== null && typeof infoPath !== "string") ||
		typeof deletedAt !== "number" ||
		typeof bytes !== "number" ||
		(sessionId !== null && typeof sessionId !== "string") ||
		typeof reason !== "string"
	) {
		return undefined;
	}
	return { id, backend, originalPath, trashedPath, infoPath, deletedAt, bytes, sessionId, reason };
}

export async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return false;
		throw error;
	}
}

/** Live entries, oldest first. Entries whose trashed item no longer exists are pruned from the index. */
export async function readEntries(agentDir: string): Promise<TrashEntry[]> {
	const dir = entriesDir(agentDir);
	let names: string[];
	try {
		names = await readdir(dir);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return [];
		throw error;
	}
	const live: TrashEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const entry = parseEntry(await readFile(join(dir, name), "utf8"));
		if (entry === undefined) continue;
		if (await pathExists(entry.trashedPath)) live.push(entry);
		else await removeEntry(agentDir, entry.id);
	}
	return live.sort((a, b) => a.deletedAt - b.deletedAt || a.id.localeCompare(b.id));
}
