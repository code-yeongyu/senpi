#!/usr/bin/env node
/*
 * build-binary.mjs
 *
 * Build the native `senpi-neo-tui` binary in release mode and stage it
 * under `packages/coding-agent/dist/neo-tui-bin/` using the
 * `senpi-neo-tui-<platform>-<arch>[.exe]` name that the Node-side
 * dispatcher (`packages/coding-agent/src/modes/neo-mode.ts`) resolves
 * at runtime.
 *
 * Bundled themes + keymap are already inlined into the binary via
 * `include_str!`, so this script only deals with the executable.
 *
 * Skip cargo entirely by setting `SENPI_NEO_TUI_SKIP_BUILD=1` (useful
 * in CI matrices that pre-build the binary or in package-only test
 * runs that do not have rustup).
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const NEO_TUI_PKG = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(NEO_TUI_PKG, "..", "..");
const CODING_AGENT_DIST = resolve(REPO_ROOT, "packages", "coding-agent", "dist");
const OUT_DIR = resolve(CODING_AGENT_DIST, "neo-tui-bin");

const PLATFORM_MAP = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH_MAP = { x64: "x64", arm64: "arm64" };

function platformInfo() {
	const platform = PLATFORM_MAP[process.platform] ?? process.platform;
	const arch = ARCH_MAP[process.arch] ?? process.arch;
	const exe = process.platform === "win32" ? ".exe" : "";
	return { platform, arch, exe };
}

function shouldSkip() {
	const skip = process.env.SENPI_NEO_TUI_SKIP_BUILD;
	return skip === "1" || skip === "true";
}

function run(cmd, args, opts = {}) {
	return new Promise((resolveExec, rejectExec) => {
		const child = spawn(cmd, args, { stdio: "inherit", cwd: REPO_ROOT, ...opts });
		child.on("error", rejectExec);
		child.on("exit", (code, signal) => {
			if (code === 0) {
				resolveExec(undefined);
				return;
			}
			rejectExec(new Error(`${cmd} ${args.join(" ")} exited with ${signal ?? code}`));
		});
	});
}

async function main() {
	const { platform, arch, exe } = platformInfo();
	const targetName = `senpi-neo-tui-${platform}-${arch}${exe}`;
	const outPath = resolve(OUT_DIR, targetName);
	const sourcePath = resolve(REPO_ROOT, "target", "release", `senpi-neo-tui${exe}`);

	if (shouldSkip()) {
		console.log(`[neo-tui] SENPI_NEO_TUI_SKIP_BUILD=1, skipping cargo build`);
		if (!existsSync(sourcePath)) {
			console.warn(`[neo-tui] expected pre-built binary at ${sourcePath} but it is missing`);
			console.warn(`[neo-tui] downstream consumers will fall back to 'senpi --neo binary not found' until provided`);
			return;
		}
	} else {
		console.log(`[neo-tui] cargo build --release --package senpi-neo-tui --bin senpi-neo-tui`);
		await run("cargo", ["build", "--release", "--package", "senpi-neo-tui", "--bin", "senpi-neo-tui"]);
	}

	if (!existsSync(sourcePath)) {
		throw new Error(`[neo-tui] cargo did not produce ${sourcePath}`);
	}
	const stat = statSync(sourcePath);
	if (!stat.isFile() || stat.size === 0) {
		throw new Error(`[neo-tui] ${sourcePath} is empty or not a regular file`);
	}

	mkdirSync(OUT_DIR, { recursive: true });
	copyFileSync(sourcePath, outPath);
	chmodSync(outPath, 0o755);

	// On macOS `cp` attaches `com.apple.provenance` to the destination.
	// Combined with the adhoc-signed Rust binary, the Gatekeeper kills
	// the process at exec with SIGKILL (exit 137) and no stderr - which
	// is exactly the failure mode where `senpi --neo` shows a blank
	// screen and immediately quits. Clear the xattrs and re-sign so the
	// binary stays runnable regardless of where it was copied from.
	if (process.platform === "darwin") {
		await run("xattr", ["-cr", outPath]).catch((err) => {
			console.warn(`[neo-tui] xattr -cr failed (continuing): ${err.message}`);
		});
		await run("codesign", ["--force", "--sign", "-", outPath]).catch((err) => {
			console.warn(`[neo-tui] codesign failed (continuing): ${err.message}`);
		});
	}

	console.log(`[neo-tui] staged ${outPath} (${stat.size} bytes)`);
}

main().catch((err) => {
	console.error(`[neo-tui] build-binary failed: ${err.message}`);
	process.exit(1);
});
