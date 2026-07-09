import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type NativePtyRuntime = "node" | "bun";

export interface NativePtyBinding {
	readonly PtySession: unknown;
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
export const NATIVE_PTY_PACKAGE_VERSION = readPackageVersion();
/**
 * Native ABI version. INTENTIONALLY decoupled from the package/CalVer version: it
 * identifies the native surface (exports + signatures) this loader requires. Must
 * match `NATIVE_PTY_ABI_VERSION` and the `__senpiPtyAbi<N>` export in
 * `crates/senpi-pty/src/lib.rs`. Bump ONLY on a backward-incompatible native change
 * (and rebuild the vendored prebuilds); a CalVer release must NOT change it.
 */
export const NATIVE_PTY_ABI_VERSION = "1";

function readPackageVersion(): string {
	// node/tsx/tarball layouts: the sibling `../package.json` resolves normally.
	try {
		const packageMetadata = cjsRequire("../package.json");
		if (isRecord(packageMetadata) && typeof packageMetadata.version === "string") {
			return packageMetadata.version;
		}
	} catch {
		// Compiled Bun binary: `../package.json` is not in the embedded FS. Fall through.
	}
	// Compiled Bun binary: the release ships package.json beside the executable. All
	// workspace packages are lockstep-versioned, so the sibling version matches pty's.
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dirname(process.execPath), "package.json"), "utf-8"));
		if (isRecord(parsed) && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {
		// No readable sibling package.json either.
	}
	throw new Error("@earendil-works/pi-pty package.json is missing a string version");
}

export function getNativePtySentinelExport(abiVersion: string = NATIVE_PTY_ABI_VERSION): string {
	return `__senpiPtyAbi${abiVersion}`;
}

export function detectNativePtyRuntime(
	versions: NodeJS.ProcessVersions & { readonly bun?: unknown } = process.versions,
): NativePtyRuntime {
	return typeof versions.bun === "string" ? "bun" : "node";
}

export function getNativePtyHost(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

export function getNativePtyCandidatePaths(options: NativePtyCandidatePathOptions = {}): readonly string[] {
	const host = getNativePtyHost(options.platform, options.arch);
	const moduleDir = options.moduleDir ?? dirname(fileURLToPath(import.meta.url));
	const execDir = options.execDir ?? dirname(process.execPath);
	const nativePath = join("native", "prebuilds", host, `senpi_pty.${host}.node`);

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
	if (!isNativePtyBinding(value)) {
		throw new NativePtySentinelMismatchError(modulePath, getNativePtySentinelExport(), []);
	}

	const actualExports = Object.keys(value).sort();
	if (typeof value.PtySession !== "function") {
		throw new NativePtySentinelMismatchError(modulePath, "PtySession", actualExports);
	}

	const sentinelExport = getNativePtySentinelExport();
	const sentinel = value[sentinelExport];
	if (!isUnknownFunction(sentinel)) {
		throw new NativePtySentinelMismatchError(modulePath, sentinelExport, actualExports);
	}

	const sentinelValue = sentinel();
	if (sentinelValue !== NATIVE_PTY_ABI_VERSION) {
		throw new NativePtySentinelMismatchError(modulePath, sentinelExport, actualExports);
	}

	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNativePtyBinding(value: unknown): value is NativePtyBinding {
	return isRecord(value) && typeof value.PtySession === "function";
}

function isUnknownFunction(value: unknown): value is () => unknown {
	return typeof value === "function";
}

function formatErrorCause(modulePath: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return `${modulePath}: ${message}`;
}
