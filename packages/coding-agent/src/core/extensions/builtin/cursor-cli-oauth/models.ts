import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCursorCatalog } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "../../types.ts";
import { defaultCursorAgentExecutableDeps, resolveCursorAgentExecutable } from "./executable.ts";

const MODEL_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_CATALOG_TTL_HOURS = 24;
const ANSI_ESCAPE_SEQUENCE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MODEL_LINE = /^(\S+)\s+-\s+(.+)$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/;
const MISLEADING_ERROR_LINE = /^\s*(?:error|failed|failure)(?=\s|:|-|$)/i;

export type CursorCliModelCatalogSettings = {
	readonly modelCatalogTtlHours?: number;
	readonly executablePath?: string;
};

export type CursorCliModelCatalogDeps = {
	now: () => number;
	resolveExecutable: () => string;
	runProbe: (executable: string, stdoutPath: string, timeoutMs: number) => Promise<void>;
	makeTemporaryDirectory: (prefix: string) => Promise<string>;
	readTextFile: (path: string) => Promise<string>;
	makeDirectory: (path: string) => Promise<void>;
	writeTextFile: (path: string, contents: string) => Promise<void>;
	renameFile: (from: string, to: string) => Promise<void>;
	removeDirectory: (path: string) => Promise<void>;
};

export type ResolveCursorCliModelCatalogOptions = {
	readonly agentDir: string;
	readonly settings?: CursorCliModelCatalogSettings;
	readonly deps?: Partial<CursorCliModelCatalogDeps>;
};

type CachedModelCatalog = {
	readonly cachedAt: number;
	readonly models: readonly ProviderModelConfig[];
};

type StaticModelDefinition = {
	readonly id: string;
	readonly label: string;
};

/**
 * Expand one model family into the variant ids the live catalog lists for it,
 * so the offline fallback normalizes into the same grouped reasoning identities
 * as a probed catalog. `thinking.style` follows the upstream id convention:
 * newer Claude families use `<family>-thinking-<level>`, older ones
 * `<family>-<level>-thinking`.
 */
function familyDefinitions(
	family: string,
	label: string,
	levels: readonly string[],
	thinking?: { readonly levels: readonly string[]; readonly style: "thinking-level" | "level-thinking" },
): StaticModelDefinition[] {
	const definitions = levels.map((level) => ({ id: `${family}-${level}`, label }));
	if (thinking) {
		for (const level of thinking.levels) {
			const id = thinking.style === "thinking-level" ? `${family}-thinking-${level}` : `${family}-${level}-thinking`;
			definitions.push({ id, label: `${label} Thinking` });
		}
	}
	return definitions;
}

const STATIC_MODEL_DEFINITIONS: readonly StaticModelDefinition[] = [
	{ id: "auto", label: "Auto" },
	{ id: "composer-2.5", label: "Composer 2.5" },
	{ id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
	...familyDefinitions("gpt-5.6-sol", "GPT-5.6 Sol 1M", ["none", "low", "medium", "high", "xhigh", "max"]),
	...familyDefinitions("gpt-5.6-luna", "GPT-5.6 Luna 1M", ["none", "low", "medium", "high", "xhigh", "max"]),
	...familyDefinitions("gpt-5.6-terra", "GPT-5.6 Terra 1M", ["none", "low", "medium", "high", "xhigh", "max"]),
	...familyDefinitions("gpt-5.5", "GPT-5.5 1M", ["none", "low", "medium", "high", "extra-high"]),
	...familyDefinitions("gpt-5.4", "GPT-5.4 1M", ["low", "medium", "high", "xhigh"]),
	...familyDefinitions("gpt-5.4-mini", "GPT-5.4 Mini", ["none", "low", "medium", "high", "xhigh"]),
	...familyDefinitions("gpt-5.4-nano", "GPT-5.4 Nano", ["none", "low", "medium", "high", "xhigh"]),
	...familyDefinitions("gpt-5.3-codex", "Codex 5.3", ["low", "high", "xhigh"]),
	...familyDefinitions("gpt-5.2", "GPT-5.2", ["low", "high", "xhigh"]),
	...familyDefinitions("gpt-5.1", "GPT-5.1", ["low", "high"]),
	{ id: "gpt-5-mini", label: "GPT-5 Mini" },
	...familyDefinitions("claude-opus-5", "Claude Opus 5 1M", ["low", "medium", "high"], {
		levels: ["low", "medium", "high", "xhigh", "max"],
		style: "thinking-level",
	}),
	...familyDefinitions("claude-opus-4-8", "Claude Opus 4.8 1M", ["low", "medium", "high", "xhigh", "max"], {
		levels: ["low", "medium", "high", "xhigh", "max"],
		style: "thinking-level",
	}),
	...familyDefinitions("claude-opus-4-7", "Claude Opus 4.7 1M", ["low", "medium", "high", "xhigh", "max"], {
		levels: ["low", "medium", "high", "xhigh", "max"],
		style: "thinking-level",
	}),
	...familyDefinitions("claude-fable-5", "Claude Fable 5 1M (NO ZDR)", ["low", "medium", "high", "xhigh", "max"], {
		levels: ["low", "medium", "high", "xhigh", "max"],
		style: "thinking-level",
	}),
	...familyDefinitions("claude-sonnet-5", "Claude Sonnet 5 1M", ["low", "medium", "high", "xhigh", "max"], {
		levels: ["low", "medium", "high", "xhigh", "max"],
		style: "thinking-level",
	}),
	...familyDefinitions("claude-4.6-opus", "Claude Opus 4.6 1M", ["high", "max"], {
		levels: ["high", "max"],
		style: "level-thinking",
	}),
	...familyDefinitions("claude-4.6-sonnet", "Claude Sonnet 4.6 1M", ["medium"], {
		levels: ["medium"],
		style: "level-thinking",
	}),
	...familyDefinitions("claude-4.5-opus", "Claude Opus 4.5", ["high"], {
		levels: ["high"],
		style: "level-thinking",
	}),
	{ id: "claude-4.5-sonnet", label: "Claude Sonnet 4.5" },
	{ id: "claude-4.5-sonnet-thinking", label: "Claude Sonnet 4.5 Thinking" },
	{ id: "claude-4-sonnet", label: "Claude Sonnet 4" },
	{ id: "claude-4-sonnet-thinking", label: "Claude Sonnet 4 Thinking" },
	...familyDefinitions("gemini-3.7-flash", "Gemini 3.7 Flash", ["low", "medium", "high"]),
	...familyDefinitions("gemini-3.6-flash", "Gemini 3.6 Flash", ["minimal", "low", "medium", "high"]),
	{ id: "gemini-3.5-flash", label: "Gemini 3.5 Flash" },
	{ id: "gemini-3-flash", label: "Gemini 3 Flash" },
	{ id: "gemini-3.1-pro", label: "Gemini 3.1 Pro" },
	...familyDefinitions("cursor-grok-4.6", "Cursor Grok 4.6", ["low", "medium", "high", "xhigh"]),
	{ id: "cursor-grok-4.6-low-fast", label: "Cursor Grok 4.6 Low Fast" },
	{ id: "cursor-grok-4.6-medium-fast", label: "Cursor Grok 4.6 Medium Fast" },
	{ id: "cursor-grok-4.6-high-fast", label: "Cursor Grok 4.6 High Fast" },
	{ id: "cursor-grok-4.6-xhigh-fast", label: "Cursor Grok 4.6 XHigh Fast" },
	...familyDefinitions("cursor-grok-4.5", "Cursor Grok 4.5", ["low", "medium", "high"]),
	...familyDefinitions("kimi-k3", "Kimi K3", ["low", "high", "max"]),
	...familyDefinitions("glm-5.2", "GLM 5.2", ["high", "max"]),
	{ id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
];

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function normalizeEntries(raw: readonly { id: string; label: string }[]): ProviderModelConfig[] {
	return normalizeCursorCatalog(
		raw.map(({ id, label }) => ({ id, name: label, input: ["text"] as const, cursorMaxMode: false })),
	).map((entry) => ({
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		...(entry.thinkingLevelMap ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		input: ["text"] as ("text" | "image")[],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.window,
		maxTokens: 64_000,
		...(entry.representativeVariantId !== undefined && entry.representativeVariantId !== entry.id
			? { upstreamModelId: entry.representativeVariantId }
			: {}),
		compat: {
			...(entry.capabilityId !== undefined && entry.representativeVariantId !== undefined
				? {
						cursorReasoning: {
							capabilityId: entry.capabilityId,
							...(entry.thinkingMode !== undefined ? { thinkingMode: entry.thinkingMode } : {}),
							representativeVariantId: entry.representativeVariantId,
						},
					}
				: {}),
		},
	}));
}

export const STATIC_CURSOR_CLI_MODELS: readonly ProviderModelConfig[] = normalizeEntries(STATIC_MODEL_DEFINITIONS);

/** Parse the complete `cursor-agent models` listing into extension provider entries. */
export function parseCursorAgentModelsListing(listing: string): ProviderModelConfig[] {
	const plainListing = stripAnsi(listing);
	const lines = plainListing.split(/\r?\n/);
	if (lines.some((line) => MISLEADING_ERROR_LINE.test(line))) return [];

	const seen = new Set<string>();
	const raw: { id: string; label: string }[] = [];
	for (const rawLine of lines) {
		const match = MODEL_LINE.exec(rawLine.trim());
		if (!match) continue;
		const id = match[1];
		const label = match[2].trim();
		if (!MODEL_ID.test(id) || label.length === 0 || seen.has(id)) continue;
		seen.add(id);
		raw.push({ id, label });
	}
	return normalizeEntries(raw);
}

async function runModelsProbe(executable: string, stdoutPath: string, timeoutMs: number): Promise<void> {
	const output = await open(stdoutPath, "w");
	try {
		await new Promise<void>((resolve, reject) => {
			const child = spawn(executable, ["models"], {
				stdio: ["ignore", output.fd, "ignore"],
			});
			let timedOut = false;
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				if (error) reject(error);
				else resolve();
			};
			const deadline = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
			child.once("error", (error) => finish(error));
			child.once("close", (code, signal) => {
				if (timedOut) {
					finish(new Error(`cursor-agent models exceeded its ${timeoutMs}ms deadline`));
					return;
				}
				if (code !== 0) {
					finish(new Error(`cursor-agent models failed with code ${String(code)} and signal ${String(signal)}`));
					return;
				}
				finish();
			});
		});
	} finally {
		await output.close();
	}
}

function defaultDeps(settings: CursorCliModelCatalogSettings): CursorCliModelCatalogDeps {
	return {
		now: Date.now,
		resolveExecutable: () => {
			const executableDeps = defaultCursorAgentExecutableDeps();
			return resolveCursorAgentExecutable({
				...executableDeps,
				settings: { executablePath: settings.executablePath },
			});
		},
		runProbe: runModelsProbe,
		makeTemporaryDirectory: (prefix) => mkdtemp(prefix),
		readTextFile: (path) => readFile(path, "utf8"),
		makeDirectory: async (path) => {
			await mkdir(path, { recursive: true });
		},
		writeTextFile: async (path, contents) => {
			await writeFile(path, contents, "utf8");
		},
		renameFile: async (from, to) => {
			await rename(from, to);
		},
		removeDirectory: async (path) => {
			await rm(path, { recursive: true, force: true });
		},
	};
}

function catalogTtlMs(settings: CursorCliModelCatalogSettings): number {
	const hours = settings.modelCatalogTtlHours;
	const validHours =
		typeof hours === "number" && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_MODEL_CATALOG_TTL_HOURS;
	return validHours * 60 * 60 * 1_000;
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 64_000;
const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function parseCachedCost(value: unknown): ProviderModelConfig["cost"] {
	if (typeof value !== "object" || value === null) return { ...ZERO_COST };
	const record = value as Record<string, unknown>;
	const rate = (key: string): number => {
		const field = record[key];
		return typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : 0;
	};
	return {
		input: rate("input"),
		output: rate("output"),
		cacheRead: rate("cacheRead"),
		cacheWrite: rate("cacheWrite"),
	};
}

function parseCachedThinkingLevelMap(value: unknown): ProviderModelConfig["thinkingLevelMap"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const map: Record<string, string | null> = {};
	for (const level of THINKING_LEVEL_KEYS) {
		const entry = record[level];
		if (entry === undefined) continue;
		if (entry !== null && typeof entry !== "string") return undefined;
		map[level] = entry;
	}
	return map as ProviderModelConfig["thinkingLevelMap"];
}

function parseCachedCompat(value: unknown): ProviderModelConfig["compat"] | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	const cursorReasoning = record.cursorReasoning;
	if (cursorReasoning === undefined) return {};
	if (typeof cursorReasoning !== "object" || cursorReasoning === null) return undefined;
	const reasoning = cursorReasoning as Record<string, unknown>;
	if (
		typeof reasoning.capabilityId !== "string" ||
		reasoning.capabilityId.length === 0 ||
		typeof reasoning.representativeVariantId !== "string" ||
		reasoning.representativeVariantId.length === 0 ||
		(reasoning.thinkingMode !== undefined && typeof reasoning.thinkingMode !== "boolean")
	) {
		return undefined;
	}
	return {
		cursorReasoning: {
			capabilityId: reasoning.capabilityId,
			...(reasoning.thinkingMode !== undefined ? { thinkingMode: reasoning.thinkingMode } : {}),
			representativeVariantId: reasoning.representativeVariantId,
		},
	} as ProviderModelConfig["compat"];
}

/**
 * Restore one cached catalog entry verbatim. The cache stores post-normalization
 * entries, so re-running grouping here would collapse every model to a flat,
 * non-reasoning identity (variants were already folded into thinkingLevelMap).
 */
function parseCachedModelEntry(candidate: unknown, seen: Set<string>): ProviderModelConfig | undefined {
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const record = candidate as Record<string, unknown>;
	const { id, name } = record;
	if (typeof id !== "string" || !MODEL_ID.test(id) || seen.has(id)) return undefined;
	if (typeof name !== "string" || name.length === 0) return undefined;
	if (record.thinkingLevelMap !== undefined && parseCachedThinkingLevelMap(record.thinkingLevelMap) === undefined) {
		return undefined;
	}
	if (record.compat !== undefined && parseCachedCompat(record.compat) === undefined) return undefined;
	seen.add(id);

	const input = Array.isArray(record.input)
		? record.input.filter((type): type is "text" | "image" => type === "text" || type === "image")
		: [];
	const contextWindow = record.contextWindow;
	const maxTokens = record.maxTokens;
	return {
		id,
		name,
		reasoning: record.reasoning === true,
		...(record.thinkingLevelMap !== undefined
			? { thinkingLevelMap: parseCachedThinkingLevelMap(record.thinkingLevelMap) }
			: {}),
		input: input.length > 0 ? input : ["text"],
		cost: parseCachedCost(record.cost),
		contextWindow:
			typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
				? contextWindow
				: FALLBACK_CONTEXT_WINDOW,
		maxTokens:
			typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : FALLBACK_MAX_TOKENS,
		...(typeof record.upstreamModelId === "string" && record.upstreamModelId.length > 0
			? { upstreamModelId: record.upstreamModelId }
			: {}),
		compat: parseCachedCompat(record.compat) ?? {},
	};
}

function parseCachedCatalog(contents: string): CachedModelCatalog | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || !("cachedAt" in parsed) || !("models" in parsed)) {
		return undefined;
	}
	const cachedAt = parsed.cachedAt;
	const models = parsed.models;
	if (typeof cachedAt !== "number" || !Number.isFinite(cachedAt) || !Array.isArray(models) || models.length === 0) {
		return undefined;
	}

	const restored: ProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const candidate of models) {
		const entry = parseCachedModelEntry(candidate, seen);
		if (!entry) return undefined;
		restored.push(entry);
	}
	return { cachedAt, models: restored };
}

async function readCache(cachePath: string, deps: CursorCliModelCatalogDeps): Promise<CachedModelCatalog | undefined> {
	try {
		return parseCachedCatalog(await deps.readTextFile(cachePath));
	} catch {
		return undefined;
	}
}

async function writeCache(
	cacheDirectory: string,
	cachePath: string,
	catalog: CachedModelCatalog,
	deps: CursorCliModelCatalogDeps,
): Promise<void> {
	const temporaryPath = `${cachePath}.${process.pid}.${catalog.cachedAt}.tmp`;
	await deps.makeDirectory(cacheDirectory);
	await deps.writeTextFile(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`);
	await deps.renameFile(temporaryPath, cachePath);
}

/** Resolve a cached or probed catalog, always degrading to the exact offline fallback. */
export async function resolveCursorCliModelCatalog(
	options: ResolveCursorCliModelCatalogOptions,
): Promise<readonly ProviderModelConfig[]> {
	const settings = options.settings ?? {};
	const deps = { ...defaultDeps(settings), ...options.deps };
	const cacheDirectory = join(options.agentDir, "cursor-cli-oauth");
	const cachePath = join(cacheDirectory, "models.json");
	const now = deps.now();
	const cached = await readCache(cachePath, deps);
	if (cached && now >= cached.cachedAt && now - cached.cachedAt < catalogTtlMs(settings)) return cached.models;

	let temporaryDirectory: string | undefined;
	try {
		const executable = deps.resolveExecutable();
		temporaryDirectory = await deps.makeTemporaryDirectory(join(tmpdir(), "senpi-cursor-models-"));
		const stdoutPath = join(temporaryDirectory, "stdout.txt");
		await deps.runProbe(executable, stdoutPath, MODEL_PROBE_TIMEOUT_MS);
		const models = parseCursorAgentModelsListing(await deps.readTextFile(stdoutPath));
		// stale-if-error: a stale real catalog still beats the static snapshot.
		if (models.length === 0) return cached?.models ?? STATIC_CURSOR_CLI_MODELS;
		try {
			await writeCache(cacheDirectory, cachePath, { cachedAt: now, models }, deps);
		} catch {
			// A read-only cache directory must not prevent provider registration.
		}
		return models;
	} catch {
		return cached?.models ?? STATIC_CURSOR_CLI_MODELS;
	} finally {
		if (temporaryDirectory !== undefined) {
			try {
				await deps.removeDirectory(temporaryDirectory);
			} catch {
				// Best-effort cleanup must not replace the catalog result.
			}
		}
	}
}
