import type { BrowserEngine } from "../../../core/browser-engine.ts";
import type { ExtensionMode } from "../../../core/extensions/types.ts";

/**
 * What a tool body running in the tool child may see of its extension context: plain, serializable data only.
 * No functions, no `ui`, no `sessionManager` - those stay on the server and are reached through host calls.
 */
export interface ChildToolContext {
	cwd: string;
	agentDir: string;
	mode: ExtensionMode;
	toolCallId: string;
	projectTrusted: boolean;
	sessionId?: string;
	model?: { provider: string; id: string };
	thinkingLevel?: string;
	serviceTier?: string;
	browserEngine?: BrowserEngine;
	sessionEnv?: Readonly<Record<string, string>>;
	goalStoreFile?: string;
}

/** The fields `narrowContext` reads; `ExtensionContext` satisfies it structurally. */
export interface NarrowableContext {
	readonly cwd: string;
	readonly agentDir: string;
	readonly mode: ExtensionMode;
	readonly model: { readonly provider: string; readonly id: string } | undefined;
	readonly thinkingLevel?: string | undefined;
	readonly serviceTier?: string | undefined;
	readonly browserEngine?: BrowserEngine | undefined;
	readonly sessionEnv?: Readonly<Record<string, string>> | undefined;
	readonly goalStoreFile?: string | undefined;
	isProjectTrusted(): boolean;
}

export function narrowContext(
	ctx: NarrowableContext,
	ids: { sessionId?: string | undefined; toolCallId: string },
): ChildToolContext {
	const narrowed: ChildToolContext = {
		cwd: ctx.cwd,
		agentDir: ctx.agentDir,
		mode: ctx.mode,
		toolCallId: ids.toolCallId,
		projectTrusted: ctx.isProjectTrusted(),
	};
	if (ids.sessionId !== undefined) narrowed.sessionId = ids.sessionId;
	if (ctx.model !== undefined) narrowed.model = { provider: ctx.model.provider, id: ctx.model.id };
	if (ctx.thinkingLevel !== undefined) narrowed.thinkingLevel = ctx.thinkingLevel;
	if (ctx.serviceTier !== undefined) narrowed.serviceTier = ctx.serviceTier;
	if (ctx.browserEngine !== undefined) narrowed.browserEngine = ctx.browserEngine;
	if (ctx.sessionEnv !== undefined) narrowed.sessionEnv = { ...ctx.sessionEnv };
	if (ctx.goalStoreFile !== undefined) narrowed.goalStoreFile = ctx.goalStoreFile;
	return narrowed;
}
