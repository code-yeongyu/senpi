/**
 * Reading the holder records of one session: which processes hold it right now. A record of a dead or
 * reused pid is reclaimed on the way, and so is one whose pid is alive but unprovable once the caller
 * has positive evidence that its host generation ended (senpi#3658).
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	breakStaleLock,
	type LockProbes,
	readLeaseText,
	reclaimLockState,
} from "./extensions/builtin/terminal/lease-file.ts";
import type { SessionHolder } from "./session-hold-errors.ts";

const HOLDER_RECORD = /^\d+\.json$/;

function parseCwd(raw: string): string | undefined {
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || !("cwd" in parsed)) return undefined;
	return typeof parsed.cwd === "string" ? parsed.cwd : undefined;
}

/** The host generation a holder record names, as written by `holdSessionFile`. */
export interface HolderGeneration {
	readonly host_instance?: string;
	readonly host_daemon_dir?: string;
}

export interface SessionHolderProbes extends LockProbes {
	/**
	 * Positive evidence that the holder's host generation has ended. Asked only about a holder whose pid
	 * is alive but whose start time cannot be compared, so a reused pid is not mistaken for it forever.
	 */
	readonly holderEnded?: (generation: HolderGeneration) => Promise<boolean>;
}

async function fenced(fenceSession: (() => Promise<void>) | undefined): Promise<boolean> {
	if (fenceSession === undefined) return false;
	return fenceSession().then(
		() => true,
		() => false,
	);
}

function holderGeneration(parsed: unknown): HolderGeneration {
	if (typeof parsed !== "object" || parsed === null) return {};
	return {
		...("host_instance" in parsed && typeof parsed.host_instance === "string"
			? { host_instance: parsed.host_instance }
			: {}),
		...("host_daemon_dir" in parsed && typeof parsed.host_daemon_dir === "string"
			? { host_daemon_dir: parsed.host_daemon_dir }
			: {}),
	};
}

/**
 * `fenceSession` advances the session file's write fence (senpi#3652). A holder released on `holderEnded` may only be
 * frozen, so it is released only after the fence moved: if it resumes, its writes are refused. Without a fence, or when
 * it cannot be written, the holder stands.
 */
export async function liveHolders(
	dir: string,
	probes: SessionHolderProbes = {},
	fenceSession?: () => Promise<void>,
): Promise<SessionHolder[]> {
	const holders: SessionHolder[] = [];
	for (const name of await readdir(dir)) {
		if (!HOLDER_RECORD.test(name)) continue;
		const path = join(dir, name);
		const before = await readLeaseText(path);
		const state = await reclaimLockState(path, probes);
		if (state.state === "stale") await breakStaleLock(path, state.raw);
		if (state.state !== "held" || state.holder === undefined) continue;
		const raw = await readLeaseText(path);
		// Never publish endpoint labels from a record replaced during the identity probe.
		const stable = raw !== undefined && raw === before;
		const parsed: unknown = stable ? JSON.parse(raw) : undefined;
		if (
			stable &&
			state.unproven === true &&
			(await probes.holderEnded?.(holderGeneration(parsed))) === true &&
			(await fenced(fenceSession))
		) {
			await breakStaleLock(path, raw);
			continue;
		}
		const endpoint =
			typeof parsed === "object" &&
			parsed !== null &&
			"host_instance" in parsed &&
			typeof parsed.host_instance === "string"
				? {
						host_instance: parsed.host_instance,
						...("host_socket" in parsed && typeof parsed.host_socket === "string"
							? { host_socket: parsed.host_socket }
							: {}),
					}
				: {};
		holders.push({ pid: state.holder.pid, cwd: stable ? parseCwd(raw) : undefined, ...endpoint });
	}
	return holders;
}
