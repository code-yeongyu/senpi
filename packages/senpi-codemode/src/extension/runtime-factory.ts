import { type ExtensionContext, withBundledBunCommands } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import {
	type CodemodeSettings,
	loadCodemodeSettings,
	type ResolvedCodemodeSettings,
	resolveEnabledLanguages,
} from "../config/settings.ts";
import { PythonEnvironments } from "../environments/python-environments.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "../interpreters/detect.ts";
import { sessionEnvironmentFrom } from "../kernels/session-env.ts";
import { resolveSessionArtifactsDir } from "../output/streaming-output.ts";
import type { EnabledEvalLanguages, EvalLanguage, EvalRuntimes } from "../tool/types.ts";
import { jsRuntimeInfo, runtimesFromAvailability } from "./runtime-info.ts";
import {
	type CodemodeSessionManager,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
} from "./session-manager.ts";

export interface CodemodeRuntimeAPI {
	readonly executeTool: AgentExecuteTool;
	getActiveTools(): string[];
	getAllTools(): readonly EvalSchemaToolInfo[];
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
	readonly runtimes: EvalRuntimes;
	readonly settings: ResolvedCodemodeSettings;
	readonly artifactsDir: string;
	readonly executeTool: AgentExecuteTool;
	readonly spawns: boolean;
	readonly pythonEnvironments?: PythonEnvironments;
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
	const sessionEnv = { ...sessionEnvironmentFrom(ctx), ...bundledBunPathEntry() };
	const configuredPoolWidth = settings.parallelPoolWidth;
	const parallelPoolWidth = Number.isFinite(configuredPoolWidth) ? Math.max(1, Math.trunc(configuredPoolWidth)) : 1;
	const manager = await create({
		sessionId,
		ownerSessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		sessionEnv,
		settings,
		availability,
		artifactsDir: artifacts.dir,
		executeTool,
		listTools: () => pi.getAllTools(),
		complete,
	});
	return {
		sessionId,
		cwd: ctx.cwd,
		parallelPoolWidth,
		manager,
		enabledLanguages,
		runtimes: runtimesFromAvailability(availability, jsRuntimeInfo()),
		settings,
		artifactsDir: artifacts.dir,
		executeTool,
		spawns: activeTools.has(settings.taskTools.task),
		...(availability.py.detected.ok && enabledLanguages.py
			? {
					pythonEnvironments: new PythonEnvironments({
						artifactsDir: artifacts.dir,
						cwd: ctx.cwd,
						interpreter: availability.py.detected.path,
						settings,
					}),
				}
			: {}),
	};
}

export function createExecuteTool(pi: CodemodeRuntimeAPI, activeTools?: ReadonlySet<string>): AgentExecuteTool {
	// A cell names tools directly and cannot run tool_search first, so eval opts in to
	// lazy activation. Eligibility still belongs to the extension that registered the tool.
	const executeTool: AgentExecuteTool = (toolName, params, executeOptions) =>
		pi.executeTool(toolName, params, { ...executeOptions, activateInactiveTool: true });
	return Object.assign(executeTool, {
		isToolAvailable: (name: string): boolean => activeTools?.has(name) ?? pi.getActiveTools().includes(name),
	});
}

// In a compiled executable, Bun Shell runs `bun` as this executable unless PATH has one, which booted
// a second agent from `bun test` in a cell (omo#9362). Kernel children get the same bundled `bun`
// directory the bash tool's PATH carries.
function bundledBunPathEntry(): Record<string, string> {
	const env = withBundledBunCommands(process.env);
	if (env === process.env) return {};
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const value = env[pathKey];
	return value === undefined ? {} : { [pathKey]: value };
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
