import { canonicalizePath } from "../utils/paths.ts";
import { SessionResumeConflictError } from "./session-resume-conflict.ts";

/** Installed only inside a shared-host session isolate, before constructing any writer. */
let reserve: ((path: string) => void) | undefined;
const publications = new Set<string>();

export function installSessionWriteReservation(reservation: (path: string) => void): void {
	if (reserve) throw new Error("Session write reservation already installed");
	reserve = reservation;
}

/** Synchronous SessionManager entry points must obtain the host grant before touching a writer. */
export function reserveSessionWrite(path: string): void {
	if (publications.size > 0 && publications.has(canonicalizePath(path))) throw new SessionResumeConflictError(path);
	reserve?.(path);
}

/**
 * An admitted candidate's asynchronous publication excludes local synchronous writers.
 * Its grant remains in snapshots even before the prepared manager becomes a persisted writer.
 */
export async function reserveSessionPublication(path: string): Promise<() => void> {
	for (;;) {
		const pending: Promise<void>[] = [];
		for (const ref of liveWriters) {
			const owner = ref.deref();
			const file = owner?.getSessionFile();
			if (file === undefined || canonicalizePath(file) !== path) continue;
			const writing = owner?.pendingSessionWrite?.();
			if (writing) pending.push(writing);
		}
		if (pending.length === 0) break;
		await Promise.all(pending);
	}
	reserveSessionWrite(path);
	publications.add(path);
	return () => publications.delete(path);
}

/** A session writer whose grant must live exactly as long as the writer itself. */
export interface SessionWriterOwner {
	getSessionFile(): string | undefined;
	isPersisted(): boolean;
	/** An exclusive-create header may still own an asynchronous descriptor. */
	pendingSessionWrite?(): Promise<void> | undefined;
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

/**
 * Whether a persisted writer other than `self` still owns `path`. Callers that release
 * per-session caches ask this so the last owner is the one that clears them; collected
 * writers are pruned here.
 */
export function hasOtherLiveSessionWriter(path: string, self: SessionWriterOwner): boolean {
	for (const ref of liveWriters) {
		const owner = ref.deref();
		if (!owner) {
			liveWriters.delete(ref);
			continue;
		}
		if (owner === self) continue;
		if (owner.isPersisted() && owner.getSessionFile() === path) return true;
	}
	return false;
}

/** Session files still owned by a live persisted writer; collected writers are pruned here. */
export function liveSessionWritePaths(): string[] {
	const paths: string[] = [...publications];
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
