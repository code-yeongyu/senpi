/**
 * Shared platform/arch mapping for the neo (Go TUI) distribution.
 *
 * The neo binary ships as per-platform npm packages named
 * `@code-yeongyu/senpi-neo-tui-<platform>-<arch>`. This module is the SINGLE
 * source of truth for how Node's `process.platform`/`process.arch` map to the
 * package-name spellings, and is consumed both by the `--neo` launcher (this
 * package) and by the cross-compile / packaging pipeline. Keep it dependency-free
 * so both sides can import it without pulling in runtime state.
 *
 * Note: package names use the npm spellings (`windows`, `x64`), NOT the Go
 * toolchain spellings (`amd64`). The GOARCH `amd64` translation lives on the
 * build side only.
 */

export type NeoPlatform = "darwin" | "linux" | "windows";
export type NeoArch = "x64" | "arm64";

/** Package scope + base name for the neo distribution. */
export const NEO_PACKAGE_SCOPE = "@code-yeongyu";
export const NEO_PACKAGE_BASE = "senpi-neo-tui";

const PLATFORM_MAP: Readonly<Record<string, NeoPlatform>> = {
	win32: "windows",
	darwin: "darwin",
	linux: "linux",
};

const ARCH_MAP: Readonly<Record<string, NeoArch>> = {
	x64: "x64",
	arm64: "arm64",
};

export interface NeoTarget {
	readonly platform: NeoPlatform;
	readonly arch: NeoArch;
}

/**
 * Map a Node `process.platform`/`process.arch` pair to a neo target, or return
 * undefined when the current host is not a supported neo target.
 */
export function resolveNeoTarget(nodePlatform: string, nodeArch: string): NeoTarget | undefined {
	const platform = PLATFORM_MAP[nodePlatform];
	const arch = ARCH_MAP[nodeArch];
	if (platform === undefined || arch === undefined) {
		return undefined;
	}
	return { platform, arch };
}

/** Full package name for a neo target, e.g. `@code-yeongyu/senpi-neo-tui-darwin-arm64`. */
export function neoPackageName(target: NeoTarget): string {
	return `${NEO_PACKAGE_SCOPE}/${NEO_PACKAGE_BASE}-${target.platform}-${target.arch}`;
}

/** Binary basename inside the platform package (`.exe` on Windows). */
export function neoBinaryFilename(platform: NeoPlatform): string {
	return platform === "windows" ? "senpi-neo.exe" : "senpi-neo";
}

/**
 * The `require.resolve` sub-path for a target's binary inside its platform
 * package, e.g. `@code-yeongyu/senpi-neo-tui-linux-x64/bin/senpi-neo`.
 */
export function neoBinaryRequirePath(target: NeoTarget): string {
	return `${neoPackageName(target)}/bin/${neoBinaryFilename(target.platform)}`;
}
