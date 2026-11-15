import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

/**
 * A loop session's documents on a hand (session port, senpi#6754): the files extensions keep beside a session (the goal
 * and /loop stores under `getSessionDir()`), which the loop owns and carries with a call as `relative path -> text`. A
 * call's work sees them as a private session directory; what it changed there goes back as `path -> text`, or `null`
 * for a removed file. Nothing outlives the call on this machine.
 */
export type SessionDocuments = Readonly<Record<string, string>>;
export type SessionDocumentChanges = Record<string, string | null>;

/** A document path names a file inside the session directory: relative, with no `..` step. */
export function isDocumentPath(path: string): boolean {
	if (path.length === 0 || isAbsolute(path)) return false;
	const normalized = normalize(path);
	return normalized === path.split("/").join(sep) && !normalized.split(sep).includes("..");
}

export async function materializeDocuments(documents: SessionDocuments): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-session-documents-"));
	for (const [path, text] of Object.entries(documents)) {
		const file = join(dir, path);
		await mkdir(dirname(file), { recursive: true, mode: 0o700 });
		await writeFile(file, text, { mode: 0o600 });
	}
	return dir;
}

async function filesUnder(dir: string, root = dir): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await filesUnder(path, root)));
		else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
	}
	return found;
}

/** The documents a call's work changed in `dir` against what the loop carried, then the directory is removed. */
export async function collectDocumentChanges(dir: string, carried: SessionDocuments): Promise<SessionDocumentChanges> {
	try {
		const changes: SessionDocumentChanges = {};
		const now = await filesUnder(dir);
		for (const path of now) {
			const text = await readFile(join(dir, path), "utf8");
			if (carried[path] !== text) changes[path] = text;
		}
		for (const path of Object.keys(carried)) if (!now.includes(path)) changes[path] = null;
		return changes;
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
