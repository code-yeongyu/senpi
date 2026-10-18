import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isQuarantinedNativeFile, QUARANTINE_ATTRIBUTE } from "@earendil-works/pi-pty";
import { getPackageDir } from "../../../config.ts";
import type { GrepEngineRequest, GrepEngineResult } from "./engine.ts";

/** ABI, not the package's CalVer. Keep aligned with crates/senpi-grep. */
export const NATIVE_GREP_ABI_VERSION = "1";

/** The napi options/results are aligned with the frozen engine contract. */
export interface NativeGrepBinding {
	__senpiGrepAbi1(): string;
	grep(options: GrepEngineRequest, signal?: AbortSignal): Promise<GrepEngineResult>;
}

export interface NativeGrepCandidatePathOptions {
	packageDir?: string;
	moduleDir?: string;
	execPath?: string;
	env?: NodeJS.ProcessEnv;
	platform?: string;
	arch?: string;
}

export interface NativeGrepLoaderOptions extends NativeGrepCandidatePathOptions {
	requireBinding?: (modulePath: string) => unknown;
	isQuarantined?: (modulePath: string) => boolean;
}

export interface NativeGrepUnavailableDiagnostic {
	code: "native-unavailable";
	host: string;
	attemptedPaths: readonly string[];
	message: string;
	cause: string;
}

export type NativeGrepLoadResult =
	| { native: NativeGrepBinding; diagnostic: null }
	| { native: null; diagnostic: NativeGrepUnavailableDiagnostic };

export class NativeGrepSentinelMismatchError extends Error {
	readonly code = "native-sentinel-mismatch";
	readonly modulePath: string;

	constructor(modulePath: string) {
		super(`Native grep ABI mismatch in ${modulePath}: expected __senpiGrepAbi1() === "1" and a grep function`);
		this.name = "NativeGrepSentinelMismatchError";
		this.modulePath = modulePath;
	}
}

export function getNativeGrepCandidatePaths(options: NativeGrepCandidatePathOptions = {}): readonly string[] {
	const env = options.env ?? process.env;
	// An explicit override is authoritative, including when it cannot be loaded.
	if (env.SENPI_GREP_NATIVE_PATH) return [env.SENPI_GREP_NATIVE_PATH];
	const host = `${options.platform ?? process.platform}-${options.arch ?? process.arch}`;
	const file = `senpi_grep.${host}.node`;
	const packageDir = options.packageDir ?? (env.SENPI_PACKAGE_DIR || getPackageDir());
	const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const execPath = options.execPath ?? process.execPath;
	return [
		join(packageDir, "native/prebuilds", host, file),
		join(moduleDir, "../../../../native/prebuilds", host, file),
		join(dirname(execPath), "native/prebuilds", host, file),
	];
}

export function loadNativeGrep(options: NativeGrepLoaderOptions = {}): NativeGrepLoadResult {
	const attemptedPaths = getNativeGrepCandidatePaths(options);
	const platform = options.platform ?? process.platform;
	const host = `${platform}-${options.arch ?? process.arch}`;
	const requireBinding = options.requireBinding ?? createRequire(import.meta.url);
	const isQuarantined = options.isQuarantined ?? ((path: string) => isQuarantinedNativeFile(path, platform));
	const causes: string[] = [];
	for (const modulePath of attemptedPaths) {
		// Probe BEFORE dlopen: Gatekeeper can block rather than returning an error.
		// Never remove quarantine attributes; retain the cause for fallback diagnostics.
		if (isQuarantined(modulePath)) {
			causes.push(`${modulePath}: blocked because ${QUARANTINE_ATTRIBUTE} is present (macOS Gatekeeper)`);
			continue;
		}
		try {
			const native = requireBinding(modulePath);
			assertNativeGrepBinding(native, modulePath);
			return { native, diagnostic: null };
		} catch (error) {
			if (error instanceof NativeGrepSentinelMismatchError) throw error;
			causes.push(`${modulePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		native: null,
		diagnostic: {
			code: "native-unavailable",
			host,
			attemptedPaths,
			message: `No native grep prebuild is available for ${host}.`,
			cause: causes.join("; "),
		},
	};
}

function assertNativeGrepBinding(value: unknown, modulePath: string): asserts value is NativeGrepBinding {
	if (
		typeof value !== "object" ||
		value === null ||
		!("grep" in value) ||
		typeof value.grep !== "function" ||
		!("__senpiGrepAbi1" in value) ||
		typeof value.__senpiGrepAbi1 !== "function" ||
		value.__senpiGrepAbi1() !== NATIVE_GREP_ABI_VERSION
	) {
		throw new NativeGrepSentinelMismatchError(modulePath);
	}
}
