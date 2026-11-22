/**
 * How many clients a supervisor has accepted on its public socket, read from the operating system.
 *
 * A host of an older engine reports no connection count on the wire, and an idle client holding a
 * connection without a session is invisible to every protocol read. The kernel still knows: an
 * accepted unix stream socket carries the address of the listener it was accepted on, so the
 * supervisor's descriptors that name the public path are its listener plus one per client.
 *
 * `undefined` means "could not be read" (another platform, a missing tool, a process that went away),
 * and every caller treats it as "a client may be there". Reading only: nothing here signals or writes.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

const LSOF_TIMEOUT_MS = 2_000;
/** `__SO_ACCEPTCON` in `/proc/net/unix` Flags: the socket is a listener. */
const LINUX_ACCEPTCON_FLAG = 0x10000;

/** Whether a socket address the kernel reported is the public socket: by name, or by the inode it resolves to. */
type PublicNameMatcher = (path: string) => Promise<boolean>;

/**
 * The kernel names a listener (and every client it accepted) by the path it was BOUND at. Since #5319 that is the
 * private `<socket>.bind-*` scratch (or its short alias), published at the public path by `link(2)`: the same
 * inode under another name. A reported path counts when it resolves to the public entry's inode. Matching only adds
 * descriptors, so the worst case is one more counted client, which keeps a host rather than stopping it.
 */
async function publicNameMatcher(socket: string): Promise<PublicNameMatcher> {
	const names = new Set([socket, await realpath(socket).catch(() => socket)]);
	const published = await lstat(socket).catch(() => undefined);
	const seen = new Map<string, boolean>();
	return async (path) => {
		if (names.has(path)) return true;
		if (published === undefined || !path.startsWith("/")) return false;
		const known = seen.get(path);
		if (known !== undefined) return known;
		const entry = await stat(path).catch(() => undefined);
		const same = entry !== undefined && entry.dev === published.dev && entry.ino === published.ino;
		seen.set(path, same);
		return same;
	};
}

export async function countPublicClients(supervisorPid: number, socket: string): Promise<number | undefined> {
	const matches = await publicNameMatcher(socket);
	const descriptors =
		process.platform === "darwin"
			? await darwinDescriptors(supervisorPid, matches)
			: process.platform === "linux"
				? await linuxDescriptors(supervisorPid, matches)
				: undefined;
	if (descriptors === undefined || descriptors.listeners === 0) return undefined;
	return descriptors.total - descriptors.listeners;
}

interface PublicDescriptors {
	readonly total: number;
	readonly listeners: number;
}

async function darwinDescriptors(pid: number, matches: PublicNameMatcher): Promise<PublicDescriptors | undefined> {
	const stdout = await new Promise<string | undefined>((resolve) => {
		execFile("lsof", ["-a", "-p", String(pid), "-U", "-w", "-F", "n"], { timeout: LSOF_TIMEOUT_MS }, (error, out) =>
			resolve(error ? undefined : out),
		);
	});
	if (stdout === undefined) return undefined;
	let total = 0;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("n") && (await matches(line.slice(1)))) total += 1;
	}
	// lsof does not mark the listening entry; a supervisor owns exactly one listener on its path.
	return { total, listeners: total > 0 ? 1 : 0 };
}

async function linuxDescriptors(pid: number, matches: PublicNameMatcher): Promise<PublicDescriptors | undefined> {
	try {
		const inodes = new Set<string>();
		for (const fd of await readdir(join("/proc", String(pid), "fd"))) {
			const target = await readlink(join("/proc", String(pid), "fd", fd)).catch(() => "");
			const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
			if (inode !== undefined) inodes.add(inode);
		}
		let total = 0;
		let listeners = 0;
		for (const line of (await readFile("/proc/net/unix", "utf8")).split("\n").slice(1)) {
			const fields = line.trim().split(/\s+/);
			const [flags, inode, path] = [fields[3], fields[6], fields[7]];
			if (inode === undefined || path === undefined || !inodes.has(inode) || !(await matches(path))) continue;
			total += 1;
			if ((Number.parseInt(flags ?? "0", 16) & LINUX_ACCEPTCON_FLAG) !== 0) listeners += 1;
		}
		return { total, listeners };
	} catch {
		return undefined;
	}
}
