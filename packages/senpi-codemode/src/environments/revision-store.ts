import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type LockWaitNotice, withRootLock } from "./install-lock.ts";
import { assertLinkStaysInside, assertNoLinksBelow, recordedInstallSources } from "./no-links.ts";
import { EnvironmentError } from "./py-installer.ts";

const POINTER = "active";
const REVISION = /^rev-(\d+)$/;

export interface Revision {
	readonly number: number;
	readonly dir: string;
}

/** The same read, synchronous: the pointer is one short file, read when a Python cell starts running. */
export function readActiveRevisionSync(base: string): Revision | undefined {
	try {
		return parsePointer(base, readFileSync(join(base, POINTER), "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function parsePointer(base: string, text: string): Revision | undefined {
	const name = text.trim();
	const match = REVISION.exec(name);
	return match?.[1] === undefined ? undefined : { number: Number(match[1]), dir: join(base, name) };
}

export async function readActiveRevision(base: string): Promise<Revision | undefined> {
	try {
		return parsePointer(base, await readFile(join(base, POINTER), "utf8"));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Builds the next revision under the root's lock: a staging copy of the active revision (so packages
 * accumulate) is handed to `build`, renamed to `rev-<n>` only after `build` succeeds, and published by an
 * atomic replace of the `active` pointer. A failed, cancelled or interrupted build is deleted; the
 * previous revision stays active and is never modified, so a running kernel never sees a partial install.
 */
export async function publishNextRevision(
	base: string,
	build: (staging: string, previous: Revision | undefined) => Promise<void>,
	signal?: AbortSignal,
	onLockWait?: (notice: LockWaitNotice) => void,
): Promise<{ readonly revision: Revision; readonly previous: Revision | undefined }> {
	await mkdirPrivate(base);
	return withRootLock(
		base,
		async () => {
			const previous = await readActiveRevision(base);
			const number = Math.max(previous?.number ?? 0, await highestRevision(base)) + 1;
			const staging = join(base, `.staging-rev-${number}-${process.pid}-${randomUUID()}`);
			const dir = join(base, `rev-${number}`);
			try {
				if (previous === undefined) await mkdir(staging, { mode: 0o700 });
				else {
					await assertNoLinksBelow(base, previous.dir);
					const sources = await recordedInstallSources(previous.dir);
					await cp(previous.dir, staging, {
						recursive: true,
						verbatimSymlinks: true,
						filter: async (source) => await assertLinkStaysInside(source, previous.dir, sources),
					});
				}
				// Explicit, not left to the umask: a revision holds the user's installed packages and carried registry config.
				await chmod(staging, 0o700);
				await build(staging, previous);
				signal?.throwIfAborted();
				await renameRetrying(staging, dir);
				const pointer = join(base, `.${POINTER}-${process.pid}-${randomUUID()}`);
				await writeFile(pointer, `rev-${number}\n`);
				await renameRetrying(pointer, join(base, POINTER));
			} catch (error) {
				await rm(staging, { recursive: true, force: true });
				throw error;
			}
			return { revision: { number, dir }, previous };
		},
		signal,
		onLockWait,
	);
}

const RENAME_RETRY_DELAYS_MS = [20, 50, 100, 200, 400, 800];

// On Windows a rename fails with EPERM/EBUSY/EACCES while another process (an indexer, antivirus) holds a
// handle on the source or the replaced file; those holds are brief, so the rename is retried before failing.
async function renameRetrying(from: string, to: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			const transient = code === "EPERM" || code === "EBUSY" || code === "EACCES";
			const delay = RENAME_RETRY_DELAYS_MS[attempt];
			if (!transient || delay === undefined) {
				const reason = error instanceof Error ? error.message : String(error);
				throw new EnvironmentError("environment_install_failed", `could not publish the new revision: ${reason}`);
			}
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}
}

async function highestRevision(base: string): Promise<number> {
	let highest = 0;
	for (const entry of await readdir(base)) {
		const match = REVISION.exec(entry);
		if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]));
	}
	return highest;
}

/** Creates `dir` and any missing parents private to the user (0700; the umask can only narrow it further). */
export async function mkdirPrivate(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}
