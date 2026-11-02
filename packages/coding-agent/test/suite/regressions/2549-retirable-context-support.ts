import type { ExtensionContext } from "../../../src/core/extensions/types.ts";

/** What `AgentSession.reload()` retires the old generation's contexts with. */
export const RELOAD_STALE_MESSAGE = "stale extension generation after reload";

/** What a disposed session (new/fork/switch replacement) retires its contexts with. */
export const REPLACEMENT_STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

export interface RetirableContext {
	/** The context a handler captures; every runner-guarded member throws once retired. */
	readonly context: ExtensionContext;
	/** A live context for the same session, as the runner hands to the shutdown handlers. */
	readonly successor: ExtensionContext;
	retire(message: string): void;
	/** Teardown only: lets the test quit a retired generation's PTYs; the runner never revives a context. */
	revive(): void;
}

interface RetirableContextOptions {
	readonly cwd: string;
	readonly sessionId: string;
	readonly ui: Record<string, unknown>;
}

/** Mirrors `ExtensionRunner.createContext`: guarded getters assert liveness on every read. */
export function retirableContext(options: RetirableContextOptions): RetirableContext {
	let staleMessage: string | undefined;
	const sessionManager = { getSessionId: () => options.sessionId, getSessionFile: () => undefined };
	const model = { id: "test-model", api: "openai-completions" };
	const guarded = <T>(value: T): T => {
		if (staleMessage !== undefined) throw new Error(staleMessage);
		return value;
	};
	const context = {
		get ui() {
			return guarded(options.ui);
		},
		get mode() {
			return guarded("tui");
		},
		get hasUI() {
			return guarded(true);
		},
		get cwd() {
			return guarded(options.cwd);
		},
		get model() {
			return guarded(model);
		},
		get sessionManager() {
			return guarded(sessionManager);
		},
	} as unknown as ExtensionContext;
	const successor = { ui: options.ui, mode: "tui", hasUI: true, cwd: options.cwd, model, sessionManager };
	return {
		context,
		successor: successor as unknown as ExtensionContext,
		retire(message) {
			staleMessage = message;
		},
		revive() {
			staleMessage = undefined;
		},
	};
}
