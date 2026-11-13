import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";

/**
 * Cross-session cell authority of every codemode copy in this realm (omo#12965, design amendment 3.2-A1).
 *
 * A realm can hold more than one copy of this extension: Node evaluates an extension again on every load, and a module
 * generation is replaced while sessions live. Two tables are looked up by session id across sessions: what each
 * session's kernels report as their cell permission state (read when another session invokes a kernel tool), and the
 * kernels a session's revocation must reach. With a table per copy, a copy answers for a session another copy
 * registered as if it had no state. So both tables live in one realm registry, in the closure of the copy that created
 * it, and every copy calls through these members.
 *
 * Nothing crosses copies through class identity. A kernel is an identity key the registry also calls through
 * `revoke()` and `retire()`; one without both is refused at registration. A snapshot and a session handle are read
 * structurally by the copy that receives them, and an unreadable one refuses (`invocation-authority.ts`,
 * `permission-sessions.ts`). The mutable session record never leaves the closure.
 */
interface CellAuthority {
	registerInvocation(sessionId: string, read: () => unknown): () => void;
	/** The current snapshot of every reader registered for `sessionId`, in registration order. */
	invocations(sessionId: string): unknown[];
	registerKernel(sessionId: string, kernel: object): unknown;
	unregisterKernel(sessionId: string, kernel: object): void;
	/** All words go DEAD synchronously, before retirement or another admission can run. */
	revoke(sessionId: string): Promise<void>;
}

interface SessionKernel {
	revoke(): void;
	retire(): Promise<void>;
}

/** One session's permission state as other copies reach it: functions only, the record stays in the closure. */
export interface PermissionSessionHandle {
	dead(): unknown;
	markDead(): void;
	pending(): unknown;
}

interface SessionRecord {
	dead: boolean;
	pending?: Promise<void>;
	readonly kernels: Set<SessionKernel>;
	readonly handle: PermissionSessionHandle;
}

function isSessionKernel(value: object): value is SessionKernel {
	return hasFunctions(value, ["revoke", "retire"]);
}

function createCellAuthority(): CellAuthority {
	const readers = new Map<string, Set<() => unknown>>();
	const sessions = new Map<string, SessionRecord>();
	const sessionFor = (sessionId: string): SessionRecord => {
		const existing = sessions.get(sessionId);
		if (existing) return existing;
		const session: SessionRecord = {
			dead: false,
			kernels: new Set(),
			handle: Object.freeze({
				dead: () => session.dead,
				markDead: () => {
					session.dead = true;
				},
				pending: () => session.pending,
			}),
		};
		sessions.set(sessionId, session);
		return session;
	};
	return {
		registerInvocation: (sessionId, read) => {
			let entries = readers.get(sessionId);
			if (!entries) {
				entries = new Set();
				readers.set(sessionId, entries);
			}
			const registered = entries;
			registered.add(read);
			return () => {
				registered.delete(read);
				if (registered.size === 0 && readers.get(sessionId) === registered) readers.delete(sessionId);
			};
		},
		invocations: (sessionId) =>
			[...(readers.get(sessionId) ?? [])].map((read) => (typeof read === "function" ? read() : undefined)),
		registerKernel: (sessionId, kernel) => {
			if (!isSessionKernel(kernel)) throw new Error("Permission authority unavailable");
			const session = sessionFor(sessionId);
			session.kernels.add(kernel);
			return session.handle;
		},
		unregisterKernel: (sessionId, kernel) => {
			const session = sessions.get(sessionId);
			if (!session || !isSessionKernel(kernel)) return;
			session.kernels.delete(kernel);
			if (!session.dead && !session.pending && session.kernels.size === 0) sessions.delete(sessionId);
		},
		revoke: (sessionId) => {
			const session = sessions.get(sessionId);
			if (!session) return Promise.resolve();
			if (session.pending) return session.pending;
			const kernels = [...session.kernels];
			// Every kernel is revoked and asked to retire whatever the others do: one that throws must not shield the
			// kernels registered after it. A kernel that could not be revoked or retired leaves the session dead, the
			// rule an abandoned retirement already follows.
			const failures: unknown[] = [];
			for (const kernel of kernels) {
				try {
					kernel.revoke();
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length > 0) session.dead = true;
			const retirements = kernels.map(async (kernel) => kernel.retire());
			const pending = Promise.allSettled(retirements).then((results) => {
				for (const result of results) if (result.status === "rejected") failures.push(result.reason);
				if (failures.length === 0) return;
				session.dead = true;
				throw failures.length === 1 ? failures[0] : new AggregateError(failures, "Permission revocation failed");
			});
			session.pending = pending;
			void pending
				.finally(() => {
					if (session.pending === pending) session.pending = undefined;
				})
				.catch(() => {});
			return pending;
		},
	};
}

export const cellAuthority = realmRegistry(
	"@code-yeongyu/senpi/codemode-cell-authority/v1",
	createCellAuthority,
	(value): value is CellAuthority =>
		hasFunctions(value, ["registerInvocation", "invocations", "registerKernel", "unregisterKernel", "revoke"]),
);

export function isPermissionSessionHandle(value: unknown): value is PermissionSessionHandle {
	return hasFunctions(value, ["dead", "markDead", "pending"]);
}
