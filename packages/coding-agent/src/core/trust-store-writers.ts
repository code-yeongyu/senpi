import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";

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
 * Runs `write` once every earlier write of this realm to `path` has finished, so no write waits on a lock another
 * write of the same realm holds.
 */
export function inTrustStoreWriteTurn(path: string, write: () => Promise<void>): Promise<void> {
	return trustStoreWriters.inTurn(path, write);
}

/**
 * Records that a write of this realm holds the store lock for `path` until the returned release runs. Call it in the
 * same synchronous step that acquired the lock: a reader of this realm then never meets the lock without the record.
 */
export function holdTrustStoreLockInRealm(path: string): () => void {
	trustStoreWriters.hold(path);
	return () => trustStoreWriters.release(path);
}

/**
 * Whether a write of this realm holds the store lock for `path` across its awaits. A synchronous reader of the same
 * realm must not wait for that lock: its wait blocks the event loop the writer needs to finish. It reads without the
 * lock instead, which is safe because the writer replaces `trust.json` in one synchronous call. Engine copies that
 * predate this registry do not consult it: their synchronous reads and writes wait out the lock's 200 ms budget
 * while such a write holds it, and fail with `ELOCKED` if it is still held then.
 */
export function trustStoreLockHeldInRealm(path: string): boolean {
	return trustStoreWriters.holds(path);
}
