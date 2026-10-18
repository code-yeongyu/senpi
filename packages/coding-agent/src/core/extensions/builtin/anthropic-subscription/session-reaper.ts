export interface SessionRegistryReapHandle {
	cancel(): void;
	unref(): void;
}

export type ReapCandidate = { generation: number; lastUsedAt: number };

export type SessionReapDeps = {
	now: () => number;
	scheduleTimer: (callback: () => void, delayMs: number) => SessionRegistryReapHandle;
	idleTtlMs: number;
	candidate: (senpiSessionId: string, generation: number) => ReapCandidate | undefined;
	expire: (senpiSessionId: string) => void;
};

type ScheduledReap = { generation: number; token: symbol; handle: SessionRegistryReapHandle };

export class SessionReapScheduler {
	private readonly scheduled = new Map<string, ScheduledReap>();

	private readonly deps: SessionReapDeps;

	constructor(deps: SessionReapDeps) {
		this.deps = deps;
	}

	arm(senpiSessionId: string, generation: number, delayMs = this.deps.idleTtlMs): void {
		const token = Symbol("session-reap");
		const handle = this.deps.scheduleTimer(() => this.fire(senpiSessionId, generation, token), delayMs);
		this.scheduled.set(senpiSessionId, { generation, token, handle });
		handle.unref();
	}

	cancel(senpiSessionId: string, generation: number): void {
		const scheduled = this.scheduled.get(senpiSessionId);
		if (!scheduled || scheduled.generation !== generation) return;
		scheduled.handle.cancel();
		this.scheduled.delete(senpiSessionId);
	}

	private fire(senpiSessionId: string, generation: number, token: symbol): void {
		const scheduled = this.scheduled.get(senpiSessionId);
		if (!scheduled || scheduled.generation !== generation || scheduled.token !== token) return;
		this.scheduled.delete(senpiSessionId);
		const candidate = this.deps.candidate(senpiSessionId, generation);
		if (!candidate) return;
		const remaining = candidate.lastUsedAt + this.deps.idleTtlMs - this.deps.now();
		if (remaining <= 0) this.deps.expire(senpiSessionId);
		else this.arm(senpiSessionId, generation, remaining);
	}
}
