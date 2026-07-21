import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentDir } from "../../../config.ts";
import type { ResourceDiagnostic } from "../../../core/diagnostics.ts";
import { loadSkills, type Skill } from "../../../core/skills.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type {
	SkillMetadata,
	SkillScope,
	SkillsListEntry,
	SkillsListParams,
	SkillsListResponse,
} from "../protocol/index.ts";
import { invalidParamsError, RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";
import type { ThreadRegistry } from "../threads/registry.ts";

export interface RegisterAppServerSkillMethodsOptions {
	readonly agentDir?: string;
	readonly serverCwd?: string;
	readonly threads?: Pick<ThreadRegistry, "listLoaded" | "getLoadedThread">;
	readonly resourceLoaderFactory?: (cwd: string) => Promise<SkillResourceLoader> | SkillResourceLoader;
}

export function registerAppServerSkillMethods(
	registry: MethodRegistry,
	options: RegisterAppServerSkillMethodsOptions = {},
): void {
	const serverCwd = resolvePath(options.serverCwd ?? process.cwd());
	const agentDir = options.agentDir ?? getAgentDir();
	const cachedLoaders = new Map<string, Promise<SkillResourceLoader>>();

	registry.register("skills/list", {
		scope: "global",
		handler: async ({ request }) => {
			const params = parseSkillsListParams(request.params);
			const requestedCwds = params.cwds && params.cwds.length > 0 ? params.cwds : [serverCwd];
			const entries = await Promise.all(
				requestedCwds.map((cwd) => {
					const resolvedCwd = resolvePath(cwd, serverCwd, { trim: true });
					return buildSkillsListEntry(resolvedCwd, params.forceReload === true, {
						agentDir,
						threads: options.threads,
						resourceLoaderFactory: options.resourceLoaderFactory,
						cachedLoaders,
					});
				}),
			);
			return { data: entries } satisfies SkillsListResponse;
		},
	});
}

type SkillsListEntryOptions = {
	readonly agentDir: string;
	readonly threads: Pick<ThreadRegistry, "listLoaded" | "getLoadedThread"> | undefined;
	readonly resourceLoaderFactory: ((cwd: string) => Promise<SkillResourceLoader> | SkillResourceLoader) | undefined;
	readonly cachedLoaders: Map<string, Promise<SkillResourceLoader>>;
};

interface SkillResourceLoader {
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	reload(): Promise<void>;
}

async function buildSkillsListEntry(
	cwd: string,
	forceReload: boolean,
	options: SkillsListEntryOptions,
): Promise<SkillsListEntry> {
	const invalidEntry = validateSkillCwd(cwd);
	if (invalidEntry) return invalidEntry;

	try {
		const loader = await getCachedLoader(cwd, options);
		if (forceReload) await loader.reload();
		const loaded = loader.getSkills();
		return {
			cwd,
			skills: loaded.skills.map(toWireSkill),
			errors: loaded.diagnostics.map((diagnostic) => toWireSkillError(diagnostic, cwd)),
		};
	} catch (error) {
		return { cwd, skills: [], errors: [{ path: cwd, message: errorMessage(error) }] };
	}
}

function validateSkillCwd(cwd: string): SkillsListEntry | undefined {
	if (!existsSync(cwd)) {
		return { cwd, skills: [], errors: [{ path: cwd, message: "skill cwd does not exist" }] };
	}
	try {
		if (!statSync(cwd).isDirectory()) {
			return { cwd, skills: [], errors: [{ path: cwd, message: "skill cwd is not a directory" }] };
		}
	} catch (error) {
		return { cwd, skills: [], errors: [{ path: cwd, message: errorMessage(error) }] };
	}
	return undefined;
}

async function getCachedLoader(cwd: string, options: SkillsListEntryOptions): Promise<SkillResourceLoader> {
	let loaderPromise = options.cachedLoaders.get(cwd);
	if (!loaderPromise) {
		loaderPromise = Promise.resolve().then(
			() => findLoadedLoader(cwd, options.threads) ?? createLoader(cwd, options),
		);
		options.cachedLoaders.set(cwd, loaderPromise);
	}
	try {
		return await loaderPromise;
	} catch (error) {
		options.cachedLoaders.delete(cwd);
		throw error;
	}
}

function findLoadedLoader(
	cwd: string,
	threads: Pick<ThreadRegistry, "listLoaded" | "getLoadedThread"> | undefined,
): SkillResourceLoader | undefined {
	if (!threads) return undefined;
	const loaded = threads.listLoaded().find((thread) => resolve(thread.cwd) === cwd);
	if (!loaded) return undefined;
	try {
		return threads.getLoadedThread(loaded.id).session.resourceLoader;
	} catch {
		return undefined;
	}
}

async function createLoader(cwd: string, options: SkillsListEntryOptions): Promise<SkillResourceLoader> {
	if (options.resourceLoaderFactory) return options.resourceLoaderFactory(cwd);
	let loaded = loadSkills({ cwd, agentDir: options.agentDir, skillPaths: [], includeDefaults: true });
	return {
		getSkills: () => loaded,
		reload: async () => {
			loaded = loadSkills({ cwd, agentDir: options.agentDir, skillPaths: [], includeDefaults: true });
		},
	};
}

function toWireSkill(skill: Skill): SkillMetadata {
	return {
		name: skill.name,
		description: skill.description,
		path: skill.filePath,
		scope: mapSkillScope(skill.sourceInfo.scope),
		enabled: !skill.disableModelInvocation,
	};
}

export function mapSkillScope(scope: Skill["sourceInfo"]["scope"]): SkillScope {
	switch (scope) {
		case "user":
			return "user";
		case "project":
			return "repo";
		case "temporary":
			return "system";
		default:
			return assertNever(scope);
	}
}

function toWireSkillError(diagnostic: ResourceDiagnostic, cwd: string) {
	return { path: diagnostic.path ?? cwd, message: diagnostic.message };
}

function parseSkillsListParams(value: unknown): SkillsListParams {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw new RpcHandlerError(invalidParamsError());
	const cwds = value.cwds;
	if (cwds !== undefined && !isStringArray(cwds)) throw new RpcHandlerError(invalidParamsError());
	const forceReload = value.forceReload;
	if (forceReload !== undefined && typeof forceReload !== "boolean") {
		throw new RpcHandlerError(invalidParamsError());
	}
	return { cwds, forceReload };
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled skill scope: ${String(value)}`);
}
