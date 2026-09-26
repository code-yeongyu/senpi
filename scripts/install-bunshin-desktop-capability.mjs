#!/usr/bin/env node
// Installs (or with --remove, uninstalls) the desktop engine's bunshin sidecar descriptor. The bunshin agent loads
// sidecar descriptors only from $BUNSHIN_CAPABILITY_DIR, so the descriptor is written there, falling back to
// $BUNSHIN_HOME/capabilities (the directory to point BUNSHIN_CAPABILITY_DIR at). Restart the agent afterwards.
//
//   node scripts/install-bunshin-desktop-capability.mjs [--engine <path>] [--remove]
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { desktopDescriptor } from "../packages/desktop-engine/bunshin/descriptor.mjs";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const { values } = parseArgs({ options: { engine: { type: "string" }, remove: { type: "boolean", default: false } } });

const bunshinHome = process.env.BUNSHIN_HOME ?? join(homedir(), ".bunshin");
const capabilityDir = process.env.BUNSHIN_CAPABILITY_DIR ?? join(bunshinHome, "capabilities");
const target = join(capabilityDir, "desktop.json");

if (values.remove) {
	rmSync(target, { force: true });
	console.log(`removed ${target}`);
	process.exit(0);
}

const host = `${process.platform}-${process.arch}`;
const binary = process.platform === "win32" ? "senpi-desktop-engine.exe" : "senpi-desktop-engine";
const executable = resolve(values.engine ?? join(repoRoot, "packages/desktop-engine/native/prebuilds", host, binary));
const { version } = JSON.parse(readFileSync(join(repoRoot, "packages/desktop-engine/package.json"), "utf8"));
mkdirSync(capabilityDir, { recursive: true });
writeFileSync(target, `${JSON.stringify(desktopDescriptor({ executable, version, bunshinHome }), null, "\t")}\n`);
console.log(`installed ${target} (engine ${executable})`);
if (process.env.BUNSHIN_CAPABILITY_DIR === undefined) {
	console.log(`start the bunshin agent with BUNSHIN_CAPABILITY_DIR=${capabilityDir} so it loads the descriptor`);
}
