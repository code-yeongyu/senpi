import { execFile } from "node:child_process";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { readProcessIdentity, processIsLive, processStartTimeMs } from "../../utils/process-identity.ts";

export const ROOT_MARKER = ".compact-spool-owner";
const Owner = z.object({
	bootNonce: z.string().min(1),
	pid: z.number().int().positive(),
	startTime: z
		.string()
		.min(1)
		.refine((value) => processStartTimeMs(value) !== undefined),
});
const Marker = z.object({ kind: z.enum(["scratch", "live"]), token: z.string().min(1), owner: Owner.nullable() });
export type RootOwner = Readonly<z.infer<typeof Owner>>;
export type RootMarker = Readonly<z.infer<typeof Marker>>;
let boot: Promise<string | null> | undefined;
let self: Promise<RootOwner | null> | undefined;

/** A boot-session identity, never an age estimate. Unsupported or unobservable means UNKNOWN. */
function bootNonce(): Promise<string | null> {
	boot ??= (async () => {
		switch (process.platform) {
			case "darwin":
				return (
					(
						await promisify(execFile)("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], { timeout: 2_000 })
					).stdout.trim() || null
				);
			case "linux":
				return (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() || null;
			default:
				return null;
		}
	})().catch((cause: unknown) => {
		if (cause instanceof Error) return null;
		throw cause;
	});
	return boot;
}

export function currentRootOwner(): Promise<RootOwner | null> {
	self ??= (async () => {
		const bootNonceValue = await bootNonce();
		if (!bootNonceValue) return null;
		const start = await readProcessIdentity(process.pid, process.platform, 2_000, processIsLive, "UTC");
		return start.kind === "present"
			? { bootNonce: bootNonceValue, pid: process.pid, startTime: start.identity }
			: null;
	})();
	return self;
}

/** Only these three proofs permit reclaim. A probe failure never becomes evidence of death. */
export async function rootOwnerState(owner: RootOwner | null): Promise<"dead" | "alive" | "unknown"> {
	const currentBoot = await bootNonce();
	if (!owner || !currentBoot) return "unknown";
	if (owner.bootNonce !== currentBoot) return "dead";
	const start = await readProcessIdentity(owner.pid, process.platform, 2_000, processIsLive, "UTC");
	switch (start.kind) {
		case "absent":
			return "dead";
		case "present":
			return start.identity === owner.startTime ? "alive" : "dead";
		case "error":
			return "unknown";
	}
}

export function privateRootStat(stat: Stats): boolean {
	return (
		stat.isDirectory() &&
		!stat.isSymbolicLink() &&
		(process.getuid === undefined || (stat.uid === process.getuid() && (stat.mode & 0o077) === 0))
	);
}

/** The file is opened no-follow, bounded, then parsed once; an old or unreadable marker is UNKNOWN. */
export async function readRootMarker(dir: string): Promise<RootMarker | undefined> {
	try {
		const path = join(dir, ROOT_MARKER);
		const entry = await lstat(path);
		if (!entry.isFile() || entry.isSymbolicLink()) return undefined;
		const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (
				!stat.isFile() ||
				stat.size > 8_192 ||
				(process.getuid !== undefined && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
			)
				return undefined;
			const parsed = Marker.safeParse(JSON.parse(await handle.readFile("utf8")));
			return parsed.success ? parsed.data : undefined;
		} finally {
			await handle.close();
		}
	} catch (cause) {
		if (cause instanceof Error) return undefined;
		throw cause;
	}
}
