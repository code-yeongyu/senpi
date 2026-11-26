import { AsyncLocalStorage } from "node:async_hooks";
import { constants, type BigIntStats } from "node:fs";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { MachineOpError } from "../errors.ts";
import { canonicalizeFilesystemPath } from "../policy/filesystem.ts";
import { isMissingPathError } from "./bounded-realpath.ts";

const serviceDirectory = new AsyncLocalStorage<string>();

/** The authenticated service's state directory adds protection; it never replaces local roots. */
export function withDeviceIdentityDirectory<T>(dir: string | undefined, run: () => T): T {
	return dir ? serviceDirectory.run(dir, run) : run();
}

function names(): string[] {
	const home = process.env.HOME || homedir();
	const service = serviceDirectory.getStore();
	return [
		join(home, ".omo/device-identity.json"),
		join(home, ".omo/device-service/device-identity.json"),
		join(home, ".config/typevault/identity.json"),
		...(process.env.XDG_CONFIG_HOME ? [join(process.env.XDG_CONFIG_HOME, "typevault/identity.json")] : []),
		...(process.env.OMO_DEVICE_SERVICE_STATE_DIR
			? [join(process.env.OMO_DEVICE_SERVICE_STATE_DIR, "device-identity.json")]
			: []),
		...(service ? [join(service, "device-identity.json")] : []),
	];
}

function variant(name: string, base: string): boolean {
	const device = base === "device-identity.json";
	const stem = device ? "device-identity" : "identity";
	if (device && name === "device-identity.pending") return true;
	const suffix = name.startsWith(`${base}.`)
		? name.slice(base.length + 1)
		: name.startsWith(`${stem}.`)
			? name.slice(stem.length + 1)
			: "";
	return (
		/^(?:pending|tmp|bak|backup|old|prev(?:ious)?|rotat(?:e|ed|ion))(?:[.-].*)?$/.test(suffix) ||
		/^\d+[.-].*tmp$/.test(suffix) ||
		/^\d+\.tmp$/.test(suffix) ||
		name === `${base}~`
	);
}

async function* protectedNames(target: string, info?: BigIntStats): AsyncGenerator<string> {
	for (const base of new Set(names())) {
		yield base;
		const dir = dirname(base);
		const name = basename(base);
		const requested = basename(target);
		if (variant(requested, name)) yield join(dir, requested);
		if (!info) continue;
		// A hard link need not resemble the identity at all. Enroll existing rotation
		// siblings by directory entry, without opening an identity or reading its contents.
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (error) {
			if (isMissingPathError(error)) continue;
			throw error;
		}
		for (const entry of entries) if (entry !== requested && variant(entry, name)) yield join(dir, entry);
	}
}

async function metadata(path: string): Promise<BigIntStats | undefined> {
	try {
		return await stat(path, { bigint: true });
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw error;
	}
}

/** Metadata only. Volume semantics, not the platform name, determine case and aliases. */
export async function checkIdentityAccess(path: string, opened?: BigIntStats): Promise<void> {
	const canonical = await canonicalizeFilesystemPath(path);
	const info = opened ?? (await metadata(canonical));
	for await (const name of protectedNames(canonical, info)) {
		if (resolve(name) === canonical || (!info && (await canonicalizeFilesystemPath(name)) === canonical)) {
			throw new MachineOpError("policy_denied", `IDENTITY_FILE_REFUSED ${name}`);
		}
		if (info) {
			const identity = await metadata(name);
			if (identity && identity.dev === info.dev && identity.ino === info.ino)
				throw new MachineOpError("policy_denied", `IDENTITY_FILE_REFUSED ${name}`);
		}
	}
}

export async function readToolText(path: string): Promise<string> {
	const file = await openToolFile(path);
	try {
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

/** Never open with O_TRUNC: the descriptor must be authorized before even a destructive write. */
export async function openToolFile(path: string, flags = constants.O_RDONLY): Promise<FileHandle> {
	await checkIdentityAccess(path);
	const handle = await open(path, flags);
	try {
		await checkIdentityAccess(path, await handle.stat({ bigint: true }));
		return handle;
	} catch (error) {
		await handle.close();
		throw error;
	}
}
