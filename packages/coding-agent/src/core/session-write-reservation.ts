/** Installed only inside a shared-host session isolate, before constructing any writer. */
let reserve: ((path: string) => void) | undefined;

export function installSessionWriteReservation(reservation: (path: string) => void): void {
	if (reserve) throw new Error("Session write reservation already installed");
	reserve = reservation;
}

/** Synchronous SessionManager entry points must obtain the host grant before touching a writer. */
export function reserveSessionWrite(path: string): void {
	reserve?.(path);
}

/** A session writer whose grant must live exactly as long as the writer itself. */
export interface SessionWriterOwner {
	getSessionFile(): string | undefined;
	isPersisted(): boolean;
}

// Weak on purpose: a writer nobody references anymore writes nothing, so its grant must not
// be kept alive by this registry. Identity removal needs the same ref the set holds.
const liveWriters = new Set<WeakRef<SessionWriterOwner>>();
const writerRefs = new WeakMap<SessionWriterOwner, WeakRef<SessionWriterOwner>>();

export function registerSessionWriter(owner: SessionWriterOwner): void {
	if (writerRefs.has(owner)) return;
	const ref = new WeakRef(owner);
	writerRefs.set(owner, ref);
	liveWriters.add(ref);
}

export function unregisterSessionWriter(owner: SessionWriterOwner): void {
	const ref = writerRefs.get(owner);
	if (!ref) return;
	writerRefs.delete(owner);
	liveWriters.delete(ref);
}

/** Session files still owned by a live persisted writer; collected writers are pruned here. */
export function liveSessionWritePaths(): string[] {
	const paths: string[] = [];
	for (const ref of liveWriters) {
		const owner = ref.deref();
		if (!owner) {
			liveWriters.delete(ref);
			continue;
		}
		const path = owner.isPersisted() ? owner.getSessionFile() : undefined;
		if (path) paths.push(path);
	}
	return paths;
}
