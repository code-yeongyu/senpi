import { spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderModelConfig } from "../../types.ts";
import { defaultCursorAgentExecutableDeps, resolveCursorAgentExecutable } from "./executable.ts";

const MODEL_PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL_CATALOG_TTL_HOURS = 24;
const ANSI_ESCAPE_SEQUENCE = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const MODEL_LINE = /^(\S+)\s+-\s+(.+)$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._/:+-]*$/;
const MISLEADING_ERROR_LINE = /^\s*(?:error|failed|failure)(?=\s|:|-|$)/i;
const REASONING_SUFFIX = /(?:^|-)(?:thinking(?:-(?:low|medium|high|xhigh|max))?|low|medium|high|xhigh|max)(?:-fast)?$/i;

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

const STATIC_MODEL_DEFINITIONS: readonly StaticModelDefinition[] = [
	{ id: "auto", label: "Auto" },
	{ id: "composer-2.5", label: "Composer 2.5 (200K context)" },
	{ id: "composer-2.5-fast", label: "Composer 2.5 Fast (200K context)" },
	{ id: "gpt-5.6-sol-high", label: "GPT 5.6 SOL High (272K context)" },
	{ id: "gpt-5.6-luna-high", label: "GPT 5.6 Luna High (272K context)" },
	{ id: "gpt-5.5-high", label: "GPT 5.5 High (272K context)" },
	{ id: "gpt-5.3-codex", label: "GPT 5.3 Codex (272K context)" },
	{ id: "gpt-5.2", label: "GPT 5.2 (272K context)" },
	{ id: "claude-opus-5-high", label: "Claude Opus 5 High (300K context)" },
	{ id: "claude-opus-5-thinking-high", label: "Claude Opus 5 Thinking High (300K context)" },
	{ id: "claude-opus-4-8-thinking-high", label: "Claude Opus 4.8 Thinking High (300K context)" },
	{ id: "claude-fable-5-thinking-high", label: "Claude Fable 5 Thinking High (300K context)" },
	{ id: "claude-sonnet-5-thinking-high", label: "Claude Sonnet 5 Thinking High (300K context)" },
	{ id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash High (1M context)" },
	{ id: "cursor-grok-4.6-high", label: "Cursor Grok 4.6 High (200K context)" },
];

function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE_SEQUENCE, "");
}

function contextWindowFor(id: string, label: string): number {
	if (/\b1\s*M\b/i.test(label)) return 1_000_000;
	if (id.toLowerCase().startsWith("claude-") && /\b300\s*K\b/i.test(label)) return 300_000;
	if (id.toLowerCase().startsWith("gpt-") && /\b272\s*K\b/i.test(label)) return 272_000;
	return 200_000;
}

function modelEntry(id: string, label: string): ProviderModelConfig {
	return {
		id,
		name: label,
		reasoning: REASONING_SUFFIX.test(id),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: contextWindowFor(id, label),
		maxTokens: 64_000,
	};
}

export const STATIC_CURSOR_CLI_MODELS: readonly ProviderModelConfig[] = STATIC_MODEL_DEFINITIONS.map(({ id, label }) =>
	modelEntry(id, label),
);

/** Parse the complete `cursor-agent models` listing into extension provider entries. */
export function parseCursorAgentModelsListing(listing: string): ProviderModelConfig[] {
	const plainListing = stripAnsi(listing);
	const lines = plainListing.split(/\r?\n/);
	if (lines.some((line) => MISLEADING_ERROR_LINE.test(line))) return [];

	const seen = new Set<string>();
	const models: ProviderModelConfig[] = [];
	for (const rawLine of lines) {
		const match = MODEL_LINE.exec(rawLine.trim());
		if (!match) continue;
		const id = match[1];
		const label = match[2].trim();
		if (!MODEL_ID.test(id) || label.length === 0 || seen.has(id)) continue;
		seen.add(id);
		models.push(modelEntry(id, label));
	}
	return models;
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

	const normalized: ProviderModelConfig[] = [];
	const seen = new Set<string>();
	for (const candidate of models) {
		if (typeof candidate !== "object" || candidate === null || !("id" in candidate) || !("name" in candidate)) {
			return undefined;
		}
		const id = candidate.id;
		const name = candidate.name;
		if (
			typeof id !== "string" ||
			!MODEL_ID.test(id) ||
			typeof name !== "string" ||
			name.length === 0 ||
			seen.has(id)
		) {
			return undefined;
		}
		seen.add(id);
		normalized.push(modelEntry(id, name));
	}
	return { cachedAt, models: normalized };
}

async function readFreshCache(
	cachePath: string,
	now: number,
	ttlMs: number,
	deps: CursorCliModelCatalogDeps,
): Promise<readonly ProviderModelConfig[] | undefined> {
	try {
		const cached = parseCachedCatalog(await deps.readTextFile(cachePath));
		if (!cached || now < cached.cachedAt || now - cached.cachedAt >= ttlMs) return undefined;
		return cached.models;
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
	const cached = await readFreshCache(cachePath, now, catalogTtlMs(settings), deps);
	if (cached) return cached;

	let temporaryDirectory: string | undefined;
	try {
		const executable = deps.resolveExecutable();
		temporaryDirectory = await deps.makeTemporaryDirectory(join(tmpdir(), "senpi-cursor-models-"));
		const stdoutPath = join(temporaryDirectory, "stdout.txt");
		await deps.runProbe(executable, stdoutPath, MODEL_PROBE_TIMEOUT_MS);
		const models = parseCursorAgentModelsListing(await deps.readTextFile(stdoutPath));
		if (models.length === 0) return STATIC_CURSOR_CLI_MODELS;
		try {
			await writeCache(cacheDirectory, cachePath, { cachedAt: now, models }, deps);
		} catch {
			// A read-only cache directory must not prevent provider registration.
		}
		return models;
	} catch {
		return STATIC_CURSOR_CLI_MODELS;
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
