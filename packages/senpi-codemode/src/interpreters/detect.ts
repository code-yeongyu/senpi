import { execFile } from "node:child_process";
import { platform as currentPlatform } from "node:os";
import { promisify } from "node:util";
import type { CodemodeSettings } from "../config/settings.ts";
import { resolveCommandPath as defaultResolveCommandPath, type ResolveCommandPath } from "./resolve-command.ts";

const execFileAsync = promisify(execFile);
const probeTimeoutMs = 3_000;

export type CodemodeLanguage = "py" | "js" | "rb" | "jl";

export interface InterpreterDetected {
	readonly ok: true;
	/** The probe command line that answered, e.g. "python3" or "py -3". */
	readonly path: string;
	readonly version: string;
	/** Absolute executable path resolved from PATH, when resolution succeeded. */
	readonly resolvedPath?: string;
}

export interface InterpreterUnavailable {
	readonly ok: false;
}

export type InterpreterDetection = InterpreterDetected | InterpreterUnavailable;

export interface ExecFileProbeOptions {
	readonly timeoutMs: number;
}

export type ExecFileProbe = (
	command: string,
	args: readonly string[],
	options: ExecFileProbeOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface CreateInterpreterDetectorOptions {
	readonly platform?: NodeJS.Platform;
	readonly execFile?: ExecFileProbe;
	readonly nodeVersion?: string;
	readonly resolveCommandPath?: ResolveCommandPath;
}

export interface InterpreterDetector {
	detect(language: CodemodeLanguage): Promise<InterpreterDetection>;
}

export interface LanguageAvailability {
	readonly enabled: boolean;
	readonly detected: InterpreterDetection;
}

export type InterpreterAvailability = {
	readonly [Language in CodemodeLanguage]: LanguageAvailability;
};

const unavailable: InterpreterUnavailable = { ok: false };

export function createInterpreterDetector(options: CreateInterpreterDetectorOptions = {}): InterpreterDetector {
	const probe = options.execFile ?? defaultExecFileProbe;
	const hostPlatform = options.platform ?? currentPlatform();
	const nodeVersion = options.nodeVersion ?? process.versions.node;
	const resolveCommand = options.resolveCommandPath ?? defaultResolveCommandPath;
	const cache = new Map<CodemodeLanguage, Promise<InterpreterDetection>>();

	return {
		detect(language) {
			const cached = cache.get(language);
			if (cached !== undefined) {
				return cached;
			}

			const pending = detectUncached(language, hostPlatform, probe, nodeVersion, resolveCommand);
			cache.set(language, pending);
			return pending;
		},
	};
}

export async function getInterpreterAvailability(
	settings: CodemodeSettings,
	detector: InterpreterDetector,
): Promise<InterpreterAvailability> {
	return {
		py: await availabilityFor("py", settings.languages.py, detector),
		js: await availabilityFor("js", settings.languages.js, detector),
		rb: await availabilityFor("rb", settings.languages.rb, detector),
		jl: await availabilityFor("jl", settings.languages.jl, detector),
	};
}

async function availabilityFor(
	language: CodemodeLanguage,
	enabled: boolean,
	detector: InterpreterDetector,
): Promise<LanguageAvailability> {
	return {
		enabled,
		detected: enabled ? await detector.detect(language) : unavailable,
	};
}

async function detectUncached(
	language: CodemodeLanguage,
	hostPlatform: NodeJS.Platform,
	probe: ExecFileProbe,
	nodeVersion: string,
	resolveCommand: ResolveCommandPath,
): Promise<InterpreterDetection> {
	if (language === "js") {
		return { ok: true, path: "node", version: nodeVersion };
	}

	for (const candidate of candidatesFor(language, hostPlatform)) {
		const result = await probeCandidate(candidate, probe, resolveCommand);
		if (result.ok) {
			return result;
		}
	}

	return unavailable;
}

async function probeCandidate(
	candidate: string,
	probe: ExecFileProbe,
	resolveCommand: ResolveCommandPath,
): Promise<InterpreterDetection> {
	const invocation = candidateInvocation(candidate);
	try {
		const result = await probe(invocation.command, [...invocation.args, "--version"], { timeoutMs: probeTimeoutMs });
		const version = parseVersion(`${result.stdout}\n${result.stderr}`);
		if (version === null) return unavailable;
		const resolvedPath = resolveCommand(invocation.command);
		return { ok: true, path: candidate, version, ...(resolvedPath === undefined ? {} : { resolvedPath }) };
	} catch {
		return unavailable;
	}
}

function candidatesFor(language: CodemodeLanguage, hostPlatform: NodeJS.Platform): readonly string[] {
	if (language === "py") {
		return hostPlatform === "win32" ? ["python", "py -3", "python3"] : ["python3", "python"];
	}
	if (language === "rb") {
		return ["ruby"];
	}
	if (language === "jl") {
		return ["julia"];
	}
	return [];
}

function candidateInvocation(candidate: string): { readonly command: string; readonly args: readonly string[] } {
	const [command, ...args] = candidate.split(" ");
	return { command: command ?? candidate, args };
}

function parseVersion(output: string): string | null {
	const match = /(?:Python|ruby|julia)\s+(?:version\s+)?v?(\d+(?:\.\d+){1,3})/i.exec(output.trim());
	return match?.[1] ?? null;
}

async function defaultExecFileProbe(
	command: string,
	args: readonly string[],
	options: ExecFileProbeOptions,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
	const result = await execFileAsync(command, [...args], { timeout: options.timeoutMs });
	return {
		stdout: String(result.stdout),
		stderr: String(result.stderr),
	};
}
