#!/usr/bin/env node
/**
 * Copy the host senpi-desktop-engine prebuild next to the compiled Bun binary (`dist/pi`) at the sidecar
 * path the engine locator probes first: `<execDir>/native/prebuilds/<host>/senpi-desktop-engine[.exe]`.
 * The engine is a standalone executable, never embedded by `bun build --compile`. When the host prebuild is
 * absent this is a no-op: `/computer status` then reports `native-unavailable`.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = `${process.platform}-${process.arch}`;
const fileName = process.platform === "win32" ? "senpi-desktop-engine.exe" : "senpi-desktop-engine";
const source = join(repoRoot, "packages", "desktop-engine", "native", "prebuilds", host, fileName);
const destDir = join(repoRoot, "packages", "coding-agent", "dist", "native", "prebuilds", host);
const dest = join(destDir, fileName);

if (!existsSync(source)) {
	process.stdout.write(`copy-desktop-engine: no host prebuild for ${host} (computer use reports native-unavailable)\n`);
	process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
chmodSync(dest, 0o755);
process.stdout.write(`copy-desktop-engine: copied ${fileName} -> ${dest}\n`);
