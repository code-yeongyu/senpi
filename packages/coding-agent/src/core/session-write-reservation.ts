import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";

/** A session writer whose grant must live exactly as long as the writer itself. */
export interface SessionWriterOwner {
	getSessionFile(): string | undefined;
	isPersisted(): boolean;
}

/**
 * The live session writers of every engine copy in this realm, and the isolate's write reservation (omo#12965).
 *
 * A realm can hold more than one copy of this module (the bundled engine next to the SDK graph a plugin imports). The
 * reservation hook is installed once, by the isolate's booting copy, and every copy's `SessionManager` must take the
 * host grant through it; the last-owner cache cleanup and the isolate snapshot must see every copy's writers. So the
 * state lives in one realm registry, and each copy calls through its members. Owners are identity keys the registry
 * also calls through `getSessionFile()` and `isPersisted()`: an owner without those two methods is skipped.
 */
interface SessionWriters {
	/** Installed only inside a shared-host session isolate, before constructing any writer; a second install throws. */
	installReservation(reservation: (path: string) => void): void;
	reserve(path: string): void;
	register(owner: object): void;
	unregister(owner: object): void;
	hasOtherLive(path: string, self: object): boolean;
	livePaths(): string[];
}

/** The session file a live persisted writer owns; `undefined` for an owner another copy shaped differently. */
function persistedPath(owner: object): string | undefined {
	const isPersisted: unknown = Reflect.get(owner, "isPersisted");
	const getSessionFile: unknown = Reflect.get(owner, "getSessionFile");
	if (typeof isPersisted !== "function" || typeof getSessionFile !== "function") return undefined;
	if (Reflect.apply(isPersisted, owner, []) !== true) return undefined;
	const path: unknown = Reflect.apply(getSessionFile, owner, []);
	return typeof path === "string" && path !== "" ? path : undefined;
}

const sessionWriters = realmRegistry(
	"@code-yeongyu/senpi/session-writers/v1",
	(): SessionWriters => {
		let reservation: ((path: string) => void) | undefined;
		// Weak on purpose: a writer nobody references anymore writes nothing, so its grant must not
		// be kept alive by this registry. Identity removal needs the same ref the set holds.
		const liveWriters = new Set<WeakRef<object>>();
		const writerRefs = new WeakMap<object, WeakRef<object>>();
		/** The live writers; collected ones are pruned here. */
		const liveOwners = (): object[] => {
			const owners: object[] = [];
			for (const ref of liveWriters) {
				const owner = ref.deref();
				if (owner === undefined) liveWriters.delete(ref);
				else owners.push(owner);
			}
			return owners;
		};
		return {
			installReservation: (next) => {
				if (reservation) throw new Error("Session write reservation already installed");
				reservation = next;
			},
			reserve: (path) => {
				reservation?.(path);
			},
			register: (owner) => {
				if (writerRefs.has(owner)) return;
				const ref = new WeakRef(owner);
				writerRefs.set(owner, ref);
				liveWriters.add(ref);
			},
			unregister: (owner) => {
				const ref = writerRefs.get(owner);
				if (!ref) return;
				writerRefs.delete(owner);
				liveWriters.delete(ref);
			},
			hasOtherLive: (path, self) => liveOwners().some((owner) => owner !== self && persistedPath(owner) === path),
			livePaths: () =>
				liveOwners()
					.map(persistedPath)
					.filter((path) => path !== undefined),
		};
	},
	(value): value is SessionWriters =>
		hasFunctions(value, ["installReservation", "reserve", "register", "unregister", "hasOtherLive", "livePaths"]),
);

export function installSessionWriteReservation(reservation: (path: string) => void): void {
	sessionWriters.installReservation(reservation);
}

/** Synchronous SessionManager entry points must obtain the host grant before touching a writer. */
export function reserveSessionWrite(path: string): void {
	sessionWriters.reserve(path);
}

export function registerSessionWriter(owner: SessionWriterOwner): void {
	sessionWriters.register(owner);
}

export function unregisterSessionWriter(owner: SessionWriterOwner): void {
	sessionWriters.unregister(owner);
}

/**
 * Whether a persisted writer other than `self` still owns `path`, in any engine copy of this realm. Callers that
 * release per-session caches ask this so the last owner is the one that clears them; collected writers are pruned here.
 */
export function hasOtherLiveSessionWriter(path: string, self: SessionWriterOwner): boolean {
	return sessionWriters.hasOtherLive(path, self);
}

/** Session files still owned by a live persisted writer of any engine copy; collected writers are pruned here. */
export function liveSessionWritePaths(): string[] {
	return sessionWriters.livePaths();
}
