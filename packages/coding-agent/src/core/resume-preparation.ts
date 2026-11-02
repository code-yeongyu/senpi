import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession } from "./agent-session.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { SessionResumeRejectedError } from "./session-resume-conflict.ts";

const preparations = new AsyncLocalStorage<ResumePreparation>();

/** The whole factory, including failures before SDK construction or after its result, has one owner. */
export class ResumePreparation {
	private readonly models = new Map<ModelRuntime, ModelRuntime>();
	private readonly sessions = new Set<AgentSession>();
	private readonly resources: Array<() => void> = [];
	private readonly checks: Array<() => boolean> = [];

	run<T>(factory: () => Promise<T>): Promise<T> {
		return preparations.run(this, factory);
	}

	isolate(runtime: ModelRuntime): ModelRuntime {
		const existing = this.models.get(runtime);
		if (existing) return existing;
		const candidate = runtime.fork();
		this.models.set(runtime, candidate);
		this.ownModelRuntime(candidate);
		return candidate;
	}

	ownModelRuntime(runtime: ModelRuntime): ModelRuntime {
		this.models.set(runtime, runtime);
		this.own(() => runtime.dispose());
		return runtime;
	}

	own(dispose: () => void): void {
		this.resources.push(dispose);
	}

	watch(check: () => boolean): void {
		this.checks.push(check);
	}

	validate(): void {
		if (this.checks.some((check) => !check()))
			throw new SessionResumeRejectedError(
				"Destination configuration changed while preparing resume; retry the switch",
			);
	}

	ownSession(session: AgentSession): void {
		this.sessions.add(session);
	}

	/** Transfer non-session resources to the accepted session's ordinary disposal. */
	accept(session: AgentSession): () => void {
		this.sessions.delete(session);
		const resources = this.resources.splice(0);
		this.models.clear();
		return () => {
			for (const dispose of resources.reverse()) dispose();
		};
	}

	async dispose(): Promise<void> {
		for (const session of this.sessions) {
			session.dispose();
			await session.whenToolChildClosed();
		}
		this.sessions.clear();
		for (const dispose of this.resources.reverse()) dispose();
		this.resources.length = 0;
		this.models.clear();
	}
}

export function currentResumePreparation(): ResumePreparation | undefined {
	return preparations.getStore();
}
