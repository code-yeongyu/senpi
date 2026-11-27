/**
 * Keeps a supervised host's private hop reachable (senpi#7452). The supervisor reaches its host child only through
 * the hop's socket NAME; once that name or its directory is gone, the child keeps serving the connections it already
 * has while every new client is refused, and nothing ends the generation. The guard re-checks the entry on an
 * interval: an absent entry is re-bound at the same path (the private 0700 directory recreated, its `.owner` naming
 * the supervisor again); an entry it cannot re-bind, or one another socket took, is reported as lost so the host
 * drains and its supervisor ends with it instead of staying half alive.
 */
import { lstat, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { type InternalHopOwner, writeInternalHopOwner } from "./host-lifecycle-scratch.ts";
import { classifyEndpointOwnership, type SocketFileIdentity } from "./socket-ownership.ts";

export const INTERNAL_HOP_GUARD_INTERVAL_MS = 5_000;

export interface InternalHopGuardOptions {
	readonly socketPath: string;
	readonly identity: SocketFileIdentity | undefined;
	/** The supervisor the recreated directory's `.owner` names; without one no `.owner` is written. */
	readonly owner?: InternalHopOwner;
	readonly bind: () => Promise<SocketFileIdentity | undefined>;
	readonly onRebound: (identity: SocketFileIdentity | undefined) => void;
	readonly onLost: (reason: string) => void;
}

export function guardInternalHop(options: InternalHopGuardOptions): () => void {
	let identity = options.identity;
	let checking = false;
	let stopped = false;
	const stop = (): void => {
		stopped = true;
		clearInterval(timer);
	};
	const lose = (reason: string): void => {
		if (stopped) return;
		stop();
		options.onLost(reason);
	};
	const check = async (): Promise<void> => {
		const ownership = await classifyEndpointOwnership(options.socketPath, identity);
		if (ownership === "replaced") return lose(`hop entry ${options.socketPath} was taken by another socket`);
		if (ownership !== "absent" || stopped) return;
		try {
			await recreatePrivateDirectory(dirname(options.socketPath), options.owner);
			identity = await options.bind();
		} catch (cause) {
			return lose(
				`hop ${options.socketPath} could not be re-bound: ${cause instanceof Error ? cause.message : cause}`,
			);
		}
		if (!stopped) options.onRebound(identity);
	};
	const timer = setInterval(() => {
		if (checking || stopped) return;
		checking = true;
		void check().finally(() => {
			checking = false;
		});
	}, INTERNAL_HOP_GUARD_INTERVAL_MS);
	timer.unref?.();
	return stop;
}

/** Non-recursive, like the original: a vanished parent is not ours to recreate, so the loss is reported instead. */
async function recreatePrivateDirectory(dir: string, owner: InternalHopOwner | undefined): Promise<void> {
	await mkdir(dir, { mode: 0o700 }).catch((cause: unknown) => {
		if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
	});
	const stat = await lstat(dir);
	const uid = process.getuid?.();
	if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0)
		throw new Error(`${dir} is not this user's private directory`);
	if (owner !== undefined) await writeInternalHopOwner(dir, owner);
}
