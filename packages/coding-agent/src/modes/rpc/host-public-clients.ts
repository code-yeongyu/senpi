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
import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

const LSOF_TIMEOUT_MS = 2_000;
/** `__SO_ACCEPTCON` in `/proc/net/unix` Flags: the socket is a listener. */
const LINUX_ACCEPTCON_FLAG = 0x10000;

export async function countPublicClients(supervisorPid: number, socket: string): Promise<number | undefined> {
	const names = new Set([socket, await realpath(socket).catch(() => socket)]);
	const descriptors =
		process.platform === "darwin"
			? await darwinDescriptors(supervisorPid, names)
			: process.platform === "linux"
				? await linuxDescriptors(supervisorPid, names)
				: undefined;
	if (descriptors === undefined || descriptors.listeners === 0) return undefined;
	return descriptors.total - descriptors.listeners;
}

interface PublicDescriptors {
	readonly total: number;
	readonly listeners: number;
}

function darwinDescriptors(pid: number, names: ReadonlySet<string>): Promise<PublicDescriptors | undefined> {
	return new Promise((resolve) => {
		execFile(
			"lsof",
			["-a", "-p", String(pid), "-U", "-w", "-F", "n"],
			{ timeout: LSOF_TIMEOUT_MS },
			(error, stdout) => {
				if (error) return resolve(undefined);
				const total = stdout.split("\n").filter((line) => line.startsWith("n") && names.has(line.slice(1))).length;
				// lsof does not mark the listening entry; a supervisor owns exactly one listener on its path.
				resolve({ total, listeners: total > 0 ? 1 : 0 });
			},
		);
	});
}

async function linuxDescriptors(pid: number, names: ReadonlySet<string>): Promise<PublicDescriptors | undefined> {
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
			if (inode === undefined || path === undefined || !inodes.has(inode) || !names.has(path)) continue;
			total += 1;
			if ((Number.parseInt(flags ?? "0", 16) & LINUX_ACCEPTCON_FLAG) !== 0) listeners += 1;
		}
		return { total, listeners };
	} catch {
		return undefined;
	}
}
