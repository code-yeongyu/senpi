import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import {
	type CodemodeSettings,
	loadCodemodeSettings,
	type ResolvedCodemodeSettings,
	resolveEnabledLanguages,
} from "../config/settings.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "../interpreters/detect.ts";
import { resolveSessionArtifactsDir } from "../output/streaming-output.ts";
import type { EnabledEvalLanguages, EvalLanguage } from "../tool/types.ts";
import {
	type CodemodeSessionManager,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
} from "./session-manager.ts";

export interface CodemodeRuntimeAPI {
	readonly executeTool: AgentExecuteTool;
	getActiveTools(): string[];
}

export interface RuntimeFactoryOptions {
	readonly createSessionManager?: (
		options: CreateCodemodeSessionManagerOptions,
	) => CodemodeSessionManager | Promise<CodemodeSessionManager>;
}

export type SessionRuntime = {
	readonly sessionId: string;
	readonly cwd: string;
	readonly parallelPoolWidth: number;
	readonly manager: CodemodeSessionManager;
	readonly enabledLanguages: EnabledEvalLanguages;
	readonly settings: ResolvedCodemodeSettings;
	readonly artifactsDir: string;
	readonly executeTool: AgentExecuteTool;
	readonly spawns: boolean;
};

export async function createRuntime(
	pi: CodemodeRuntimeAPI,
	ctx: ExtensionContext,
	event: unknown,
	complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>,
	options: RuntimeFactoryOptions,
): Promise<SessionRuntime> {
	const loaded = await loadCodemodeSettings({ cwd: ctx.cwd });
	const settings: ResolvedCodemodeSettings = {
		...loaded.settings,
		languages: resolveEnabledLanguages(loaded.settings),
	};
	const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
	const enabledLanguages = enabledLanguagesFrom(settings, availability);
	const artifacts = resolveSessionArtifactsDir(ctx.sessionManager.getSessionFile());
	const activeTools = new Set(pi.getActiveTools());
	const executeTool = createExecuteTool(pi, activeTools);
	const create = options.createSessionManager ?? createCodemodeSessionManager;
	const sessionId = sessionIdFrom(event);
	const configuredPoolWidth = settings.parallelPoolWidth;
	const parallelPoolWidth = Number.isFinite(configuredPoolWidth) ? Math.max(1, Math.trunc(configuredPoolWidth)) : 1;
	const manager = await create({
		sessionId,
		cwd: ctx.cwd,
		settings,
		availability,
		artifactsDir: artifacts.dir,
		executeTool,
		complete,
	});
	return {
		sessionId,
		cwd: ctx.cwd,
		parallelPoolWidth,
		manager,
		enabledLanguages,
		settings,
		artifactsDir: artifacts.dir,
		executeTool,
		spawns: activeTools.has(settings.taskTools.task),
	};
}

export function createExecuteTool(pi: CodemodeRuntimeAPI, activeTools?: ReadonlySet<string>): AgentExecuteTool {
	const executeTool: AgentExecuteTool = (toolName, params, executeOptions) =>
		pi.executeTool(toolName, params, executeOptions);
	return Object.assign(executeTool, {
		isToolAvailable: (name: string): boolean => activeTools?.has(name) ?? pi.getActiveTools().includes(name),
	});
}

function sessionIdFrom(event: unknown): string {
	if (typeof event === "object" && event !== null && "sessionId" in event && typeof event.sessionId === "string") {
		return event.sessionId;
	}
	return crypto.randomUUID();
}

export function enabledLanguagesFrom(
	settings: CodemodeSettings,
	availability: InterpreterAvailability,
): Record<EvalLanguage, boolean> {
	return {
		py: settings.languages.py && availability.py.detected.ok,
		js: settings.languages.js && availability.js.detected.ok,
		rb: settings.languages.rb && availability.rb.detected.ok,
		jl: settings.languages.jl && availability.jl.detected.ok,
	};
}
