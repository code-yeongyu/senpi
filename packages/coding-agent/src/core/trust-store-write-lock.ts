import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
import lockfile from "proper-lockfile";

/** The trust store writes of this realm, in any engine copy: queued per file, and which of them holds its lock. */
interface TrustStoreWriters {
	readonly inTurn: (path: string, write: () => Promise<void>) => Promise<void>;
	readonly hold: (path: string) => void;
	readonly release: (path: string) => void;
	readonly holds: (path: string) => boolean;
}

const trustStoreWriters = realmRegistry(
	"@code-yeongyu/senpi/trust-store-writers/v1",
	(): TrustStoreWriters => {
		const tails = new Map<string, Promise<void>>();
		const held = new Set<string>();
		return {
			inTurn: (path, write) => {
				const turn = (tails.get(path) ?? Promise.resolve()).then(write);
				const tail = turn.then(
					() => undefined,
					() => undefined,
				);
				tails.set(path, tail);
				void tail.then(() => {
					if (tails.get(path) === tail) tails.delete(path);
				});
				return turn;
			},
			hold: (path) => {
				held.add(path);
			},
			release: (path) => {
				held.delete(path);
			},
			holds: (path) => held.has(path),
		};
	},
	(value): value is TrustStoreWriters => hasFunctions(value, ["inTurn", "hold", "release", "holds"]),
);

/**
 * Whether a writer in this realm holds the store lock for `path` across its awaits. A synchronous reader in the same
 * realm must not wait for that lock: its wait blocks the event loop the writer needs to finish. It reads without the
 * lock instead, which is safe because the writer replaces `trust.json` in one synchronous call.
 */
export function trustStoreLockHeldInRealm(path: string): boolean {
	return trustStoreWriters.holds(path);
}

/**
 * Runs `write` holding the trust store lock for `path`. Writes in this realm take turns, so none waits on a lock
 * another one holds; a writer in another process is waited for without blocking the event loop, ten attempts twenty
 * milliseconds apart, as the synchronous reader lock.
 */
export function withTrustStoreWriteLock(path: string, write: () => Promise<void>): Promise<void> {
	return trustStoreWriters.inTurn(path, async () => {
		const trustDir = dirname(path);
		await mkdir(trustDir, { recursive: true });
		const unlock = await lockfile.lock(trustDir, {
			realpath: false,
			lockfilePath: `${path}.lock`,
			retries: { retries: 9, minTimeout: 20, maxTimeout: 20 },
		});
		trustStoreWriters.hold(path);
		try {
			await write();
		} finally {
			trustStoreWriters.release(path);
			await unlock();
		}
	});
}
