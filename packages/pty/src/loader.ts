import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NativePtyRuntime = "node" | "bun";

export interface NativePtyBinding {
	readonly version: () => string;
	readonly [exportName: string]: unknown;
}

export interface NativePtyUnavailableDiagnostic {
	readonly code: "native-unavailable";
	readonly runtime: NativePtyRuntime;
	readonly host: string;
	readonly attemptedPath: string;
	readonly attemptedPaths: readonly string[];
	readonly message: string;
	readonly cause?: string;
}

export type NativePtyLoadResult =
	| {
			readonly native: NativePtyBinding;
			readonly diagnostic: null;
	  }
	| {
			readonly native: null;
			readonly diagnostic: NativePtyUnavailableDiagnostic;
	  };

export class NativePtySentinelMismatchError extends Error {
	readonly code = "native-sentinel-mismatch";
	readonly modulePath: string;
	readonly expectedExport: string;
	readonly actualExports: readonly string[];

	constructor(modulePath: string, expectedExport: string, actualExports: readonly string[]) {
		super(
			`@earendil-works/pi-pty native sentinel mismatch: expected ${expectedExport}() in ${modulePath}, exports=${actualExports.join(",") || "<none>"}`,
		);
		this.name = "NativePtySentinelMismatchError";
		this.modulePath = modulePath;
		this.expectedExport = expectedExport;
		this.actualExports = actualExports;
	}
}

export interface NativePtyCandidatePathOptions {
	readonly runtime?: NativePtyRuntime;
	readonly platform?: string;
	readonly arch?: string;
	readonly moduleDir?: string;
	readonly execDir?: string;
}

export type NativePtyRequireBinding = (modulePath: string) => unknown;

export interface NativePtyLoaderOptions extends NativePtyCandidatePathOptions {
	readonly requireBinding?: NativePtyRequireBinding;
}

const cjsRequire = createRequire(import.meta.url);
const SENTINEL_EXPORT = "version";

export function detectNativePtyRuntime(
	versions: { readonly bun?: unknown } = process.versions as typeof process.versions & { readonly bun?: unknown },
): NativePtyRuntime {
	return typeof versions.bun === "string" ? "bun" : "node";
}

export function getNativePtyHost(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

export function getNativePtyCandidatePaths(options: NativePtyCandidatePathOptions = {}): readonly string[] {
	const runtime = options.runtime ?? detectNativePtyRuntime();
	const host = getNativePtyHost(options.platform, options.arch);
	const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const execDir = options.execDir ?? dirname(process.execPath);
	const nativePath = join("native", runtime, "prebuilds", host, `senpi_pty.${host}.node`);

	return [join(moduleDir, "..", nativePath), join(moduleDir, nativePath), join(execDir, nativePath)];
}

export function loadNativePty(options: NativePtyLoaderOptions = {}): NativePtyLoadResult {
	const runtime = options.runtime ?? detectNativePtyRuntime();
	const host = getNativePtyHost(options.platform, options.arch);
	const attemptedPaths = getNativePtyCandidatePaths({ ...options, runtime });
	const requireBinding = options.requireBinding ?? cjsRequire;
	const causes: string[] = [];

	for (const modulePath of attemptedPaths) {
		try {
			const native = requireBinding(modulePath);
			return {
				native: assertNativePtyBinding(native, modulePath),
				diagnostic: null,
			};
		} catch (error) {
			if (error instanceof NativePtySentinelMismatchError) throw error;
			causes.push(formatErrorCause(modulePath, error));
		}
	}

	return {
		native: null,
		diagnostic: {
			code: "native-unavailable",
			runtime,
			host,
			attemptedPath: attemptedPaths[0] ?? "",
			attemptedPaths,
			message: `No @earendil-works/pi-pty ${runtime} native prebuild is available for ${host}.`,
			cause: causes.join("; "),
		},
	};
}

function assertNativePtyBinding(value: unknown, modulePath: string): NativePtyBinding {
	if (typeof value !== "object" || value === null) {
		throw new NativePtySentinelMismatchError(modulePath, SENTINEL_EXPORT, []);
	}

	const actualExports = Object.keys(value).sort();
	const sentinel = (value as { readonly version?: unknown }).version;
	if (typeof sentinel !== "function") {
		throw new NativePtySentinelMismatchError(modulePath, SENTINEL_EXPORT, actualExports);
	}

	const sentinelValue = sentinel();
	if (typeof sentinelValue !== "string") {
		throw new NativePtySentinelMismatchError(modulePath, SENTINEL_EXPORT, actualExports);
	}

	return value as NativePtyBinding;
}

function formatErrorCause(modulePath: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${modulePath}: ${message}`;
}
