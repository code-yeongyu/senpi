import type { InterpreterAvailability } from "../interpreters/detect.ts";
import type { EvalLanguage, EvalRuntimeInfo, EvalRuntimes } from "../tool/types.ts";

export interface JsRuntimeVersions {
	readonly node: string;
	readonly bun?: string | undefined;
}

/**
 * Global-registry key the coding-agent binary loader publishes before loading
 * this package from the physical sidecar of a compiled binary. Compiled hosts
 * load codemode from disk, so this module's own url carries no bunfs marker;
 * the host's classification is the authoritative signal. Follows the
 * Symbol.for registry convention of the interactive theme.
 */
const COMPILED_HOST_KEY = Symbol.for("@earendil-works/pi-coding-agent:compiled-binary-host");

/**
 * Exact module-url shapes of Bun's virtual filesystem in compiled binaries:
 * posix `file:///$bunfs/...` and the windows virtual drive
 * `file:///<drive>:/~BUN/...` (raw or percent-encoded). Anchored so stock bun
 * runs from disk paths that merely contain a marker segment never match.
 */
const POSIX_VIRTUAL_URL_PREFIX = "file:///$bunfs/";
const WINDOWS_VIRTUAL_URL_PATTERN = /^file:\/\/\/[A-Za-z]:\/(?:~BUN|%7EBUN)\//;

export interface NativeRuntimeSignals {
	readonly bunVersion?: string | undefined;
	readonly moduleUrl?: string | undefined;
	readonly hostCompiledBinary?: boolean | undefined;
}

/**
 * True when the bun runtime hosting this code is a compiled standalone binary
 * (an omo/pi native build): the in-process JS kernel then runs inside the
 * application binary itself rather than a stock bun install.
 */
export function isNativeSelfRuntime(signals: NativeRuntimeSignals = processNativeSignals()): boolean {
	const bun = signals.bunVersion;
	if (bun === undefined || bun.length === 0) return false;
	if (signals.hostCompiledBinary === true) return true;
	const moduleUrl = signals.moduleUrl ?? "";
	return moduleUrl.startsWith(POSIX_VIRTUAL_URL_PREFIX) || WINDOWS_VIRTUAL_URL_PATTERN.test(moduleUrl);
}

function processNativeSignals(): NativeRuntimeSignals {
	return {
		bunVersion: process.versions.bun,
		moduleUrl: import.meta.url,
		hostCompiledBinary: Reflect.get(globalThis, COMPILED_HOST_KEY) === true,
	};
}

/**
 * Identity of the in-process JS kernel host: native when a compiled binary
 * hosts the kernel itself, bun when its marker exists, node otherwise.
 */
export function jsRuntimeInfo(
	versions: JsRuntimeVersions = process.versions,
	execPath: string = process.execPath,
	nativeSelf: boolean = isNativeSelfRuntime(),
): EvalRuntimeInfo {
	const bun = versions.bun;
	if (bun !== undefined && bun.length > 0) {
		return { name: nativeSelf ? "native" : "bun", version: bun, path: execPath };
	}
	return { name: "node", version: versions.node, path: execPath };
}

/**
 * Short host-line segment, e.g. "node 26.7.0" or "bun 1.4.0". Stays
 * runtime-truthful for the eval prompt, so a native binary still reads "bun":
 * the model needs the engine capability surface, not the install identity.
 */
export function jsRuntimeLabel(versions: JsRuntimeVersions = process.versions): string {
	const info = jsRuntimeInfo(versions, "", false);
	return `${info.name} ${info.version}`;
}

const subprocessRuntimeNames = { py: "python", rb: "ruby", jl: "julia" } as const;
const subprocessLanguages = ["py", "rb", "jl"] as const;

/** Maps detected interpreters to display runtimes, preferring resolved absolute paths. */
export function runtimesFromAvailability(availability: InterpreterAvailability, js: EvalRuntimeInfo): EvalRuntimes {
	const runtimes: Partial<Record<EvalLanguage, EvalRuntimeInfo>> = { js };
	for (const language of subprocessLanguages) {
		const detected = availability[language].detected;
		if (!detected.ok) continue;
		runtimes[language] = {
			name: subprocessRuntimeNames[language],
			version: detected.version,
			path: detected.resolvedPath ?? detected.path,
		};
	}
	return runtimes;
}
