import { constants, type Stats } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { ConfigReferenceError, type ConfigReferenceReason } from "@earendil-works/pi-ai/utils/config-reference";

const MAX_BYTES = 65_536;
const readableWarnings = new Set<string>();

interface FileReference {
	readonly field: string;
	readonly reference: { $file: string };
	readonly baseDir: string;
}

function fail(input: FileReference, reason: ConfigReferenceReason): never {
	throw new ConfigReferenceError(input.field, input.reference, reason);
}

function checkOwner(input: FileReference, stat: Stats): void {
	if (process.platform !== "win32" && stat.uid !== 0 && stat.uid !== process.getuid?.()) {
		fail(input, "unsafe-owner");
	}
}

function checkWritable(input: FileReference, stat: Stats, ancestor: boolean): void {
	if (process.platform === "win32" || stat.isSymbolicLink() || (stat.mode & 0o022) === 0) return;
	if (ancestor && stat.isDirectory() && (stat.mode & 0o1000) !== 0) return;
	fail(input, "unsafe-permissions");
}

function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/** `~/` names the home directory; any other relative path is relative to the declaring config. */
function absolutePath(input: FileReference): string {
	const declared = input.reference.$file;
	const fromHome = declared.startsWith("~/") || (process.platform === "win32" && declared.startsWith("~\\"));
	if (fromHome) return `${homedir()}${sep}${declared.slice(2)}`;
	return isAbsolute(declared) ? declared : `${input.baseDir}${sep}${declared}`;
}

/** Walk the original spelling and every symlink target before opening any bytes. */
async function walk(input: FileReference): Promise<{ path: string; stat: Stats }> {
	const absolute = absolutePath(input);
	let current = parse(absolute).root;
	let pending = absolute.slice(current.length).split(sep).filter(Boolean);
	let stat = await lstat(current);
	let links = 0;
	checkOwner(input, stat);
	checkWritable(input, stat, true);
	for (let part = pending.shift(); part !== undefined; part = pending.shift()) {
		if (part === ".") continue;
		if (!stat.isDirectory()) fail(input, "non-regular");
		const next = part === ".." ? dirname(current) : join(current, part);
		const nextStat = await lstat(next);
		checkOwner(input, nextStat);
		if (
			process.platform !== "win32" &&
			(stat.mode & 0o022) !== 0 &&
			!nextStat.isSymbolicLink() &&
			(nextStat.mode & 0o022) !== 0
		) {
			fail(input, "unsafe-permissions");
		}
		checkWritable(input, nextStat, pending.length > 0);
		// A sticky writable parent is safe only while its next entry cannot be
		// modified by another user; checkOwner and checkWritable enforce that.
		if (nextStat.isSymbolicLink()) {
			if (++links > 40) fail(input, "unreadable");
			const target = await readlink(next);
			if (!sameFile(nextStat, await lstat(next))) fail(input, "changed");
			const targetPath = isAbsolute(target) ? target : `${current}${sep}${target}`;
			current = parse(targetPath).root;
			pending = [...targetPath.slice(current.length).split(sep).filter(Boolean), ...pending];
			stat = await lstat(current);
			checkOwner(input, stat);
			checkWritable(input, stat, true);
		} else {
			current = next;
			stat = nextStat;
		}
	}
	if (!stat.isFile()) fail(input, "non-regular");
	return { path: current, stat };
}

export async function readConfigReferenceFile(input: FileReference): Promise<string> {
	try {
		const walked = await walk(input);
		const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
		const handle = await open(walked.path, flags);
		try {
			const stat = await handle.stat();
			if (!sameFile(walked.stat, stat)) fail(input, "changed");
			if (!stat.isFile()) fail(input, "non-regular");
			checkOwner(input, stat);
			checkWritable(input, stat, false);
			if (stat.size > MAX_BYTES) fail(input, "oversize");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			if (length > MAX_BYTES) fail(input, "oversize");
			let value: string;
			try {
				value = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).trim();
			} catch {
				fail(input, "invalid-utf8");
			}
			if (value.length === 0) fail(input, "empty");
			if (process.platform !== "win32" && (stat.mode & 0o044) !== 0 && !readableWarnings.has(walked.path)) {
				readableWarnings.add(walked.path);
				console.warn(`${input.field}: reference file is readable by other users`);
			}
			return value;
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof ConfigReferenceError) throw error;
		const code = Reflect.get(Object(error), "code");
		fail(input, code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable");
	}
}
