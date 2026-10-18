#!/usr/bin/env node
/**
 * Local-dev helper: build senpi-grep with the pinned napi CLI and stage a
 * host-named copy under the gitignored coding-agent prebuild path.
 *
 * napi tags keep the toolchain suffix (`linux-x64-gnu`); loaders look for
 * `senpi_grep.${process.platform}-${process.arch}.node`.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const crateDir = join(repoRoot, "crates", "senpi-grep");
const host = `${process.platform}-${process.arch}`;

const build = spawnSync(
	"npm",
	["exec", "--yes", "--package", "@napi-rs/cli@3.7.2", "--", "napi", "build", "--platform", "--release"],
	{ cwd: crateDir, stdio: "inherit", shell: process.platform === "win32" },
);
if (build.status !== 0) {
	process.exit(build.status ?? 1);
}

const produced = readdirSync(crateDir).filter((name) => name.startsWith("senpi_grep.") && name.endsWith(".node"));
const hostPrefix = `senpi_grep.${host}`;
const sourceName = produced.find((name) => name.startsWith(hostPrefix));
if (!sourceName) {
	process.stderr.write(
		`build-native-grep-local: napi produced no ${hostPrefix}*.node (found: ${produced.join(", ") || "none"})\n`,
	);
	process.exit(1);
}

const destDir = join(repoRoot, "packages", "coding-agent", "native", "prebuilds", host);
mkdirSync(destDir, { recursive: true });
const destName = `senpi_grep.${host}.node`;
const dest = join(destDir, destName);
copyFileSync(join(crateDir, sourceName), dest);
process.stdout.write(`build-native-grep-local: ${sourceName} -> packages/coding-agent/native/prebuilds/${host}/${destName}\n`);
