import { type ExtensionContext, withBundledBunCommands } from "@code-yeongyu/senpi";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import type { EvalSchemaToolInfo } from "../bridges/schema-bridge.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import { resolveJsIsolation } from "../config/feature-settings.ts";
import { withoutUntrustedInterpreter } from "../config/project-trust.ts";
import {
	type CodemodeSettings,
	loadCodemodeSettings,
	type ResolvedCodemodeSettings,
	resolveEnabledLanguages,
} from "../config/settings.ts";
import { JsEnvironments } from "../environments/js-environments.ts";
import { PythonEnvironments } from "../environments/python-environments.ts";
import type { HandleRegistry } from "../handles/handle-registry.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
	type InterpreterAvailability,
} from "../interpreters/detect.ts";
import { processRuntimeInfo } from "../kernels/js/process-worker.ts";
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
	readonly jsEnvironments: JsEnvironments;
};

export async function createRuntime(
	pi: CodemodeRuntimeAPI,
	ctx: ExtensionContext,
	event: unknown,
	complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>,
	options: RuntimeFactoryOptions,
	handles?: HandleRegistry,
): Promise<SessionRuntime> {
	const loaded = await loadCodemodeSettings({ cwd: ctx.cwd });
	const trusted = withoutUntrustedInterpreter(
		loaded.settings,
		loaded.source,
		ctx.cwd,
		typeof ctx.isProjectTrusted === "function" ? () => ctx.isProjectTrusted() : undefined,
	);
	const settings: ResolvedCodemodeSettings = {
		...trusted.settings,
		languages: resolveEnabledLanguages(trusted.settings),
	};
	const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
	const pyReason = availability.py.detected.ok ? undefined : availability.py.detected.reason;
	reportSettingsProblems(ctx, [
		...loaded.warnings,
		...(trusted.warning === undefined ? [] : [trusted.warning]),
		...(pyReason === undefined ? [] : [pyReason]),
	]);
	const enabledLanguages = enabledLanguagesFrom(settings, availability);
	const jsProcessIsolation = resolveJsIsolation(settings) === "process";
	const artifacts = resolveSessionArtifactsDir(ctx.sessionManager.getSessionFile());
	const activeTools = new Set(pi.getActiveTools());
	const executeTool = createExecuteTool(pi, activeTools);
	const create = options.createSessionManager ?? createCodemodeSessionManager;
	const sessionId = sessionIdFrom(event);
	const sessionEnv = { ...sessionEnvironmentFrom(ctx), ...bundledBunPathEntry() };
	const configuredPoolWidth = settings.parallelPoolWidth;
	const parallelPoolWidth = Number.isFinite(configuredPoolWidth) ? Math.max(1, Math.trunc(configuredPoolWidth)) : 1;
	const pythonEnvironments =
		availability.py.detected.ok && enabledLanguages.py
			? new PythonEnvironments({
					artifactsDir: artifacts.dir,
					cwd: ctx.cwd,
					interpreter: availability.py.detected.path,
					settings,
				})
			: undefined;
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
		...(handles === undefined ? {} : { handles }),
		...(pythonEnvironments === undefined ? {} : { environments: { python: pythonEnvironments } }),
	});
	return {
		sessionId,
		cwd: ctx.cwd,
		parallelPoolWidth,
		manager,
		enabledLanguages,
		runtimes: runtimesFromAvailability(
			availability,
			(jsProcessIsolation ? processRuntimeInfo(undefined) : undefined) ??
				jsRuntimeInfo(process.versions, process.execPath, jsProcessIsolation),
		),
		settings,
		artifactsDir: artifacts.dir,
		executeTool,
		spawns: activeTools.has(settings.taskTools.task),
		jsEnvironments: new JsEnvironments({
			artifactsDir: artifacts.dir,
			cwd: ctx.cwd,
			runtime: jsRuntimeInfo().name,
			env: { ...process.env, ...sessionEnv },
			settings,
		}),
		...(pythonEnvironments === undefined ? {} : { pythonEnvironments }),
	};
}

/** Settings problems reach the user: a notice with a UI, otherwise stderr (print and RPC runs). */
function reportSettingsProblems(ctx: ExtensionContext, problems: readonly string[]): void {
	for (const problem of problems) {
		if (ctx.hasUI) ctx.ui.notify(`[senpi-codemode] ${problem}`, "warning");
		else console.error(`[senpi-codemode] ${problem}`);
	}
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
