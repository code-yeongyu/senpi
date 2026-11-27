/**
 * The freedesktop.org Trash specification, implemented directly so it works headless: an item moves into
 * `<trash>/files/<name>` beside `<trash>/info/<name>.trashinfo` naming its original path and deletion date.
 * The trash is always on the item's own volume (the home trash, or `$topdir/.Trash-$uid`); nothing is ever
 * copied across devices.
 */
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { mountTop } from "./disk.ts";
import { pathExists } from "./entries.ts";
import { errnoCode, TrashError } from "./trash-error.ts";

export type RenameFn = (from: string, to: string) => Promise<void>;

const MAX_NAME_ATTEMPTS = 1000;

export function homeTrashDir(env: NodeJS.ProcessEnv): string {
	const dataHome = env.XDG_DATA_HOME;
	if (dataHome !== undefined && isAbsolute(dataHome)) return join(dataHome, "Trash");
	const home = env.HOME;
	if (home === undefined || !isAbsolute(home)) {
		throw new TrashError("no_trash", "Neither XDG_DATA_HOME nor HOME is an absolute path; there is no home trash.");
	}
	return join(home, ".local", "share", "Trash");
}

async function ensureTrashDir(dir: string): Promise<void> {
	await mkdir(join(dir, "files"), { recursive: true, mode: 0o700 });
	await mkdir(join(dir, "info"), { recursive: true, mode: 0o700 });
}

/** The trash on the target's volume: the home trash when they share a device, otherwise the mount's own. */
export async function freedesktopTrashFor(target: string, env: NodeJS.ProcessEnv, uid: number): Promise<string> {
	const home = homeTrashDir(env);
	await ensureTrashDir(home);
	const targetDevice = (await lstat(target)).dev;
	if ((await lstat(home)).dev === targetDevice) return home;
	const topdir = await mountTop(target);
	const volumeTrash = join(topdir, `.Trash-${uid}`);
	try {
		await ensureTrashDir(volumeTrash);
	} catch (error) {
		const code = errnoCode(error);
		if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
			throw new TrashError(
				"no_trash",
				`${target} is on another volume than the home trash and ${volumeTrash} cannot be created (${code}); refusing to copy it across devices.`,
			);
		}
		throw error;
	}
	return volumeTrash;
}

function encodeTrashPath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function localDeletionDate(at: number): string {
	const date = new Date(at);
	const two = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function candidateName(base: string, attempt: number): string {
	return attempt === 1 ? base : `${base}.${attempt}`;
}

/** Reserves a unique name the way the spec asks: create the `.trashinfo` with O_EXCL before moving anything. */
async function reserveName(trashDir: string, original: string, deletedAt: number): Promise<string> {
	const content = `[Trash Info]\nPath=${encodeTrashPath(original)}\nDeletionDate=${localDeletionDate(deletedAt)}\n`;
	for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
		const name = candidateName(basename(original), attempt);
		const infoPath = join(trashDir, "info", `${name}.trashinfo`);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(infoPath, "wx", 0o600);
		} catch (error) {
			if (errnoCode(error) === "EEXIST") continue;
			throw error;
		}
		try {
			await handle.writeFile(content, "utf8");
		} finally {
			await handle.close();
		}
		if (!(await pathExists(join(trashDir, "files", name)))) return name;
		await rm(infoPath, { force: true });
	}
	throw new TrashError(
		"trash_full",
		`No free name for ${basename(original)} in ${trashDir} after ${MAX_NAME_ATTEMPTS} attempts.`,
	);
}

export async function moveToFreedesktopTrash(
	target: string,
	trashDir: string,
	deletedAt: number,
	renameFn: RenameFn = rename,
): Promise<{ readonly trashedPath: string; readonly infoPath: string }> {
	const name = await reserveName(trashDir, target, deletedAt);
	const infoPath = join(trashDir, "info", `${name}.trashinfo`);
	const trashedPath = join(trashDir, "files", name);
	try {
		await renameFn(target, trashedPath);
	} catch (error) {
		await rm(infoPath, { force: true });
		if (errnoCode(error) === "EXDEV") {
			throw new TrashError(
				"cross_device",
				`${target} cannot be moved to ${trashDir} without crossing devices; refusing to copy it. Nothing was deleted.`,
			);
		}
		throw error;
	}
	return { trashedPath, infoPath };
}
