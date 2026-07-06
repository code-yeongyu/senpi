/**
 * Resolve the neo (Go TUI) binary for the current host.
 *
 * Resolution order (first hit wins):
 *   1. SENPI_NEO_BIN env override (dev / packagers) — used as-is.
 *   2. `--neo-bin <path>` dev override (passed in explicitly by the launcher).
 *   3. require.resolve of the per-platform package
 *      `@code-yeongyu/senpi-neo-tui-<platform>-<arch>/bin/senpi-neo[.exe]`,
 *      tried from both this module's resolution root and the installed
 *      executable's directory (mirrors the clipboard-native optional-dep
 *      precedent in utils/clipboard-native.ts).
 *
 * On failure, returns a single actionable error message (no stack trace) so the
 * launcher can print it and exit 1.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { neoBinaryRequirePath, neoPackageName, resolveNeoTarget } from "./platform.ts";

type NeoRequire = (id: string) => string;

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);

export type NeoBinaryResolution =
	| { readonly ok: true; readonly path: string; readonly source: "env" | "dev-flag" | "package" }
	| { readonly ok: false; readonly message: string };

export interface ResolveNeoBinaryOptions {
	/** Explicit dev override from `--neo-bin` (takes precedence over package resolution). */
	readonly devBinPath?: string;
	/** Value of SENPI_NEO_BIN (highest precedence). Defaults to process.env at call time. */
	readonly envBinPath?: string;
	/** Overridable for tests: defaults to process.platform. */
	readonly nodePlatform?: string;
	/** Overridable for tests: defaults to process.arch. */
	readonly nodeArch?: string;
	/** Overridable for tests: resolution roots tried in order. */
	readonly requires?: readonly NeoRequire[];
}

export function resolveNeoBinary(options: ResolveNeoBinaryOptions = {}): NeoBinaryResolution {
	const envBinPath = options.envBinPath ?? process.env.SENPI_NEO_BIN;
	if (envBinPath !== undefined && envBinPath.length > 0) {
		return { ok: true, path: envBinPath, source: "env" };
	}

	if (options.devBinPath !== undefined && options.devBinPath.length > 0) {
		return { ok: true, path: options.devBinPath, source: "dev-flag" };
	}

	const nodePlatform = options.nodePlatform ?? process.platform;
	const nodeArch = options.nodeArch ?? process.arch;
	const target = resolveNeoTarget(nodePlatform, nodeArch);
	if (target === undefined) {
		return {
			ok: false,
			message: unsupportedHostMessage(nodePlatform, nodeArch),
		};
	}

	const requires = options.requires ?? [moduleRequire, executableDirRequire];
	const requirePath = neoBinaryRequirePath(target);
	for (const requireNeo of requires) {
		try {
			return { ok: true, path: requireNeo(requirePath), source: "package" };
		} catch {
			// Try the next resolution root.
		}
	}

	return { ok: false, message: missingPackageMessage(neoPackageName(target)) };
}

function unsupportedHostMessage(nodePlatform: string, nodeArch: string): string {
	return [
		`The neo TUI (--neo) has no prebuilt binary for this host (${nodePlatform}/${nodeArch}).`,
		"Supported targets: darwin/linux/windows on x64/arm64.",
		"Run senpi without --neo to use the classic TUI.",
	].join("\n");
}

function missingPackageMessage(packageName: string): string {
	return [
		`The neo TUI (--neo) requires the platform package "${packageName}", which is not installed.`,
		`Install it with:  npm install -g ${packageName}`,
		"Or set SENPI_NEO_BIN to the path of a senpi-neo binary.",
		"Run senpi without --neo to use the classic TUI.",
	].join("\n");
}
