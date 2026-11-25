import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { agyChildEnvironment } from "./environment.ts";
import { resolveAgyExecutable } from "./executable.ts";
import { type AgyModelEntry, parseAgyModels, rememberCatalogEntries } from "./models.ts";
import { type AntigravityAuthMethod, DEFAULT_ANTIGRAVITY_AUTH_METHOD } from "./settings.ts";

const POSITIVE_STATUS_TTL_MS = 5 * 60_000;
const NEGATIVE_STATUS_TTL_MS = 15_000;
const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
const MAX_STDOUT_BYTES = 256 * 1024;
export const AVAILABILITY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

type CachedAvailabilityEntry = {
	readonly schemaVersion: 1;
	readonly executable: string;
	readonly executableMtimeMs: number;
	readonly authMethod: AntigravityAuthMethod;
	readonly ok: true;
	readonly checkedAt: number;
};

export type AgyProbeResult = { ok: boolean; stdout: string };

export type ProbeChild = {
	stdout: { on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown };
	once(event: "error", listener: (error: Error) => void): unknown;
	once(event: "close", listener: (code: number | null) => void): unknown;
	kill(signal: "SIGKILL"): unknown;
};

export type AgyAuthStatusReader = (signal?: AbortSignal, options?: { force?: boolean }) => Promise<boolean>;

export function createAgyAuthStatusReader(
	probe: (options?: { force?: boolean }) => Promise<boolean>,
	now: () => number = Date.now,
): AgyAuthStatusReader {
	let cached: { at: number; value: boolean } | undefined;
	let inFlight: Promise<boolean> | undefined;
	const startProbe = (force: boolean): Promise<boolean> => {
		const status = probe({ force }).then((value) => {
			cached = { at: now(), value };
			return value;
		});
		inFlight = status;
		const clear = () => {
			if (inFlight === status) inFlight = undefined;
		};
		void status.then(clear, clear);
		return status;
	};
	return (signal, options) => {
		if (signal?.aborted) return Promise.reject(signal.reason);
		if (options?.force === true) {
			return untilAborted(startProbe(true), signal);
		}
		if (cached !== undefined) {
			const ttl = cached.value ? POSITIVE_STATUS_TTL_MS : NEGATIVE_STATUS_TTL_MS;
			if (now() - cached.at < ttl) return Promise.resolve(cached.value);
		}
		return untilAborted(inFlight ?? startProbe(false), signal);
	};
}

function untilAborted(status: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal === undefined) return status;
	if (signal.aborted) return Promise.reject(signal.reason);
	const abortController = new AbortController();
	const aborted = new Promise<never>((_resolve, reject) => {
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
			signal: abortController.signal,
		});
	});
	return Promise.race([status, aborted]).finally(() => abortController.abort());
}

export type ProbeAgyModelsOptions = {
	executable: string;
	env: Record<string, string>;
	timeoutMs?: number;
	force?: boolean;
	spawnProbe?: (command: string, args: readonly string[], env: Record<string, string>) => ProbeChild;
};

function runSimpleProbe(
	executable: string,
	args: readonly string[],
	env: Record<string, string>,
	timeoutMs: number,
	spawnProbe?: ProbeAgyModelsOptions["spawnProbe"],
): Promise<{ code: number | null; stdout: string }> {
	const doSpawn =
		spawnProbe ??
		((command, commandArgs, childEnv) =>
			spawn(command, [...commandArgs], {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
				env: childEnv,
			}) as ProbeChild);
	let child: ProbeChild;
	try {
		child = doSpawn(executable, args, env);
	} catch {
		return Promise.resolve({ code: null, stdout: "" });
	}

	return new Promise((resolve) => {
		let settled = false;
		let stdout = "";
		let stdoutBytes = 0;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			resolve({ code, stdout });
		};
		const deadline = setTimeout(() => {
			try {
				child.kill("SIGKILL");
			} catch {
				finish(null);
			} finally {
				finish(null);
			}
		}, timeoutMs);
		deadline.unref?.();
		child.stdout.on("data", (chunk) => {
			if (stdoutBytes >= MAX_STDOUT_BYTES) return;
			const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			const remaining = MAX_STDOUT_BYTES - stdoutBytes;
			const bytes = Buffer.from(text);
			const kept = bytes.subarray(0, remaining);
			stdout += kept.toString("utf8");
			stdoutBytes += kept.length;
		});
		child.once("error", () => finish(null));
		child.once("close", (code) => finish(code));
	});
}

const acpSupportedByExecutable = new Map<string, boolean>();

export async function probeAgyAcpSupport(options: ProbeAgyModelsOptions): Promise<boolean> {
	const cached = acpSupportedByExecutable.get(options.executable);
	if (cached !== undefined && options.spawnProbe === undefined && options.force !== true) return cached;
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const res = await runSimpleProbe(options.executable, ["acp", "--help"], options.env, timeoutMs, options.spawnProbe);
	const ok = res.code === 0;
	if (options.spawnProbe === undefined) {
		acpSupportedByExecutable.set(options.executable, ok);
	}
	return ok;
}

export async function probeAgyModels(options: ProbeAgyModelsOptions): Promise<AgyProbeResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const res = await runSimpleProbe(options.executable, ["models"], options.env, timeoutMs, options.spawnProbe);
	if (res.code === 0 && options.spawnProbe === undefined) {
		const parsed = parseAgyModels(res.stdout);
		if (parsed.length > 0) {
			mostRecentDefaultProbeModels = parsed;
			rememberCatalogEntries(parsed);
		}
		return { ok: parsed.length > 0, stdout: res.stdout };
	}
	return {
		ok: res.code === 0 && parseAgyModels(res.stdout).length > 0,
		stdout: res.stdout,
	};
}

export type ProbeAgyAuthStatusOptions = {
	settings?: { executablePath?: string; authMethod?: AntigravityAuthMethod };
	timeoutMs?: number;
	env?: Record<string, string>;
	parentEnv?: Record<string, string | undefined>;
	resolveExecutable?: (settings: { executablePath?: string }) => string;
	spawnProbe?: ProbeAgyModelsOptions["spawnProbe"];
	cachePath?: string;
	force?: boolean;
	now?: () => number;
};

let mostRecentDefaultProbeModels: readonly AgyModelEntry[] | undefined;

function statMtimeMs(path: string): number | undefined {
	try {
		const mtime = statSync(path).mtimeMs;
		return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : undefined;
	} catch {
		return undefined;
	}
}

function readAvailabilityCacheSync(
	cachePath: string,
	expected: { executable: string; executableMtimeMs: number; authMethod: AntigravityAuthMethod },
	now: number,
	ttlMs = AVAILABILITY_CACHE_TTL_MS,
): { ok: true; fresh: boolean } | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(cachePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const rec = parsed as Record<string, unknown>;
		if (
			rec.schemaVersion !== 1 ||
			rec.ok !== true ||
			rec.executable !== expected.executable ||
			rec.executableMtimeMs !== expected.executableMtimeMs ||
			rec.authMethod !== expected.authMethod ||
			typeof rec.checkedAt !== "number" ||
			!Number.isFinite(rec.checkedAt)
		) {
			return undefined;
		}
		return {
			ok: true,
			fresh: now >= rec.checkedAt && now - rec.checkedAt < ttlMs,
		};
	} catch {
		return undefined;
	}
}

async function writeAvailabilityCache(cachePath: string, entry: CachedAvailabilityEntry): Promise<void> {
	try {
		await mkdir(dirname(cachePath), { recursive: true });
		await writeFile(cachePath, JSON.stringify(entry), "utf8");
	} catch {
		// Cache persistence is best-effort; never fail availability checks on read-only paths.
	}
}

function hasEnvAuth(authMethod: AntigravityAuthMethod, parentEnv: Record<string, string | undefined>): boolean {
	if (authMethod === "gemini-api-key") {
		return typeof parentEnv.GEMINI_API_KEY === "string" && parentEnv.GEMINI_API_KEY.length > 0;
	}
	if (authMethod === "agent-platform") {
		return typeof parentEnv.GOOGLE_CLOUD_PROJECT === "string" && parentEnv.GOOGLE_CLOUD_PROJECT.length > 0;
	}
	return false;
}

export async function probeAgyAuthStatus(options: ProbeAgyAuthStatusOptions = {}): Promise<boolean> {
	let executable: string;
	try {
		executable = (options.resolveExecutable ?? resolveAgyExecutable)(options.settings ?? {});
	} catch {
		return false;
	}

	const parentEnv = options.parentEnv ?? process.env;
	const authMethod: AntigravityAuthMethod = options.settings?.authMethod ?? DEFAULT_ANTIGRAVITY_AUTH_METHOD;
	if (!hasEnvAuth(authMethod, parentEnv)) return false;

	const now = (options.now ?? Date.now)();
	const cachePath = options.spawnProbe === undefined ? options.cachePath : undefined;
	const mtimeMs = cachePath !== undefined ? statMtimeMs(executable) : undefined;
	if (cachePath !== undefined && options.force !== true && mtimeMs !== undefined) {
		const cached = readAvailabilityCacheSync(cachePath, { executable, executableMtimeMs: mtimeMs, authMethod }, now);
		if (cached?.ok === true && cached.fresh) return true;
	}

	const childEnv = options.env ?? agyChildEnvironment(parentEnv, { authMethod });
	const acpOk = await probeAgyAcpSupport({
		executable,
		env: childEnv,
		timeoutMs: options.timeoutMs,
		force: options.force === true || cachePath !== undefined,
		spawnProbe: options.spawnProbe,
	});

	if (!acpOk) return false;

	if (cachePath !== undefined && mtimeMs !== undefined) {
		await writeAvailabilityCache(cachePath, {
			schemaVersion: 1,
			executable,
			executableMtimeMs: mtimeMs,
			authMethod,
			ok: true,
			checkedAt: now,
		});
	}

	return true;
}

export function lastProbedModels(): readonly AgyModelEntry[] | undefined {
	return mostRecentDefaultProbeModels;
}

export const readAgyAuthStatus = createAgyAuthStatusReader(() => probeAgyAuthStatus());
