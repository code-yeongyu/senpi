#!/usr/bin/env node
/**
 * Copy the host @earendil-works/pi-pty native prebuild next to the compiled Bun binary
 * (`dist/pi`) at the sidecar path its loader probes: `<execDir>/native/prebuilds/<host>/
 * senpi_pty.<host>.node`, where host = `${process.platform}-${process.arch}`.
 *
 * The `.node` is NOT embedded by `bun build --compile`; the loader resolves it as a sidecar
 * relative to `process.execPath`. When the host prebuild is absent, this is a no-op and the
 * runtime falls back to the child_process pipe backend.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = `${process.platform}-${process.arch}`;
const fileName = `senpi_pty.${host}.node`;
const source = join(repoRoot, "packages", "pty", "native", "prebuilds", host, fileName);
const destDir = join(repoRoot, "packages", "coding-agent", "dist", "native", "prebuilds", host);
const dest = join(destDir, fileName);

if (!existsSync(source)) {
	process.stdout.write(`copy-pty-native: no host prebuild for ${host} (pipe fallback will be used)\n`);
	process.exit(0);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);
process.stdout.write(`copy-pty-native: copied ${fileName} -> ${dest}\n`);
