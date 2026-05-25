/**
 * `--neo` dispatch: spawn the native Rust + ratatui TUI binary and let it
 * own the terminal directly. The Node process waits for the child to exit
 * and propagates the status code.
 *
 * The binary is shipped alongside the npm package under
 * `dist/neo-tui-bin/senpi-neo-tui-<platform>-<arch>`. In dev (when running
 * from source), set `SENPI_NEO_TUI_DEV=1` to use
 * `../neo-tui/target/release/senpi-neo-tui` or `target/debug/senpi-neo-tui`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";

import type { Args } from "../cli/args.ts";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

interface PlatformInfo {
	platform: string;
	arch: string;
	exe: string;
}

function platformInfo(): PlatformInfo {
	const platformMap: Record<string, string> = {
		darwin: "darwin",
		linux: "linux",
		win32: "windows",
	};
	const archMap: Record<string, string> = {
		x64: "x64",
		arm64: "arm64",
	};
	const platform = platformMap[process.platform] ?? process.platform;
	const arch = archMap[process.arch] ?? process.arch;
	const exe = process.platform === "win32" ? ".exe" : "";
	return { platform, arch, exe };
}

function resolveBinaryPath(): { path: string; source: string } | undefined {
	const { platform, arch, exe } = platformInfo();
	const fileName = `senpi-neo-tui-${platform}-${arch}${exe}`;

	// 1. Explicit override wins over everything else - that is what makes
	//    it an override.
	const override = process.env.SENPI_NEO_TUI_BIN;
	if (override && existsSync(override)) {
		return { path: override, source: "SENPI_NEO_TUI_BIN" };
	}

	// 2. Production: alongside the dist/cli.js script.
	const distPath = resolve(SCRIPT_DIR, "..", "neo-tui-bin", fileName);
	if (existsSync(distPath)) {
		return { path: distPath, source: "dist" };
	}

	// 3. Dev: target/{release,debug}/senpi-neo-tui in the workspace tree.
	if (process.env.SENPI_NEO_TUI_DEV === "1") {
		const repoRoot = resolve(SCRIPT_DIR, "..", "..", "..", "..");
		const releasePath = resolve(repoRoot, "target", "release", `senpi-neo-tui${exe}`);
		if (existsSync(releasePath)) {
			return { path: releasePath, source: "target/release" };
		}
		const debugPath = resolve(repoRoot, "target", "debug", `senpi-neo-tui${exe}`);
		if (existsSync(debugPath)) {
			return { path: debugPath, source: "target/debug" };
		}
	}

	return undefined;
}

/**
 * Split the original argv between the senpi backend and the neo TUI
 * binary using the `--` sentinel. Anything BEFORE the sentinel (with
 * `--neo` filtered out) goes to the backend; anything AFTER goes to the
 * Rust TUI verbatim. Exported for unit tests; do not call directly from
 * production code, use {@link runNeoMode}.
 */
export function splitNeoArgs(originalArgv: readonly string[]): { backend: string[]; neo: string[] } {
	const sentinelIdx = originalArgv.indexOf("--");
	const beforeSentinel = sentinelIdx >= 0 ? originalArgv.slice(0, sentinelIdx) : [...originalArgv];
	const neo = sentinelIdx >= 0 ? originalArgv.slice(sentinelIdx + 1) : [];
	const backend = beforeSentinel.filter((arg) => arg !== "--neo");
	return { backend, neo };
}

export interface RunNeoModeOptions {
	parsed: Args;
	originalArgv: readonly string[];
	/**
	 * Binary the Rust TUI spawns to talk to the senpi backend. In practice
	 * this is `process.execPath` (Node) and `senpiScript` carries the path
	 * to the senpi CLI script. Spawning Node directly avoids the
	 * `senpi` shell-shim layer and works the same on every platform.
	 */
	senpiBin: string;
	/** Absolute path to the senpi CLI JS entry, prepended to backend args. */
	senpiScript: string;
}

/**
 * Launch the Rust TUI binary with stdio inherited so it owns the TTY.
 * The Rust binary spawns `senpi --mode rpc` as its own child for the agent
 * backend. If no backend is configured, it runs offline (demo mode or an
 * empty idle session).
 */
export async function runNeoMode(options: RunNeoModeOptions): Promise<number> {
	const located = resolveBinaryPath();
	if (!located) {
		const { platform, arch, exe } = platformInfo();
		console.error(
			chalk.red(
				[
					"Error: --neo TUI binary not found.",
					`Expected: dist/neo-tui-bin/senpi-neo-tui-${platform}-${arch}${exe}`,
					"For dev, build the crate (cargo build --release --package senpi-neo-tui)",
					"and re-run with SENPI_NEO_TUI_DEV=1, or set SENPI_NEO_TUI_BIN.",
				].join("\n"),
			),
		);
		return 1;
	}

	if (options.parsed.verbose) {
		console.log(chalk.dim(`neo-tui: launching ${located.path} (source: ${located.source})`));
	}

	// Flag forwarding contract:
	//   senpi --neo [senpi-flags...] -- [neo-tui-flags...]
	// Everything BEFORE the `--` sentinel (minus `--neo`) is treated as
	// senpi-backend args and routed to `senpi --mode rpc` via env. Anything
	// AFTER the sentinel is passed verbatim to the `senpi-neo-tui` binary,
	// which has its own clap parser for `--theme`, `--list-themes`,
	// `--demo`, `--demo-seconds`, `--backend-bin`, `--backend-args`.
	// This lets users keep typing the senpi CLI flags they already know
	// while still being able to drive the neo TUI's own flags without a
	// naming collision (`--theme` means different things on each side).
	const { backend, neo: neoArgs } = splitNeoArgs(options.originalArgv);

	// senpi runs as `node <senpiScript> <args>` so prepend the script to
	// the arg vector; `--mode rpc` switches the child into the JSONL RPC
	// server that the Rust TUI talks to.
	const backendArgs = [options.senpiScript, ...backend, "--mode", "rpc"];

	const env = {
		...process.env,
		SENPI_NEO_BACKEND_BIN: options.senpiBin,
		SENPI_NEO_BACKEND_ARGS: JSON.stringify(backendArgs),
	};

	const child: ChildProcess = spawn(located.path, neoArgs, {
		stdio: "inherit",
		env,
	});

	return new Promise<number>((resolveExit) => {
		child.on("exit", (code, signal) => {
			if (signal) {
				resolveExit(128 + (signalNumber(signal) ?? 0));
				return;
			}
			resolveExit(code ?? 0);
		});
		child.on("error", (err) => {
			console.error(chalk.red(`neo-tui: failed to launch ${located.path}: ${err.message}`));
			resolveExit(1);
		});
	});
}

function signalNumber(signal: NodeJS.Signals): number | undefined {
	// node ships a full POSIX signal -> number table in os.constants.signals
	// (SIGKILL=9, SIGSEGV=11, SIGUSR1=10, and so on). Reuse it instead of
	// maintaining a hand-rolled map that drops everything outside the
	// happy path.
	const signals = osConstants.signals as Readonly<Record<string, number>>;
	return signals[signal];
}
