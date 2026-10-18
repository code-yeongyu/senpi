import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

export function isInside(path: string, dir: string): boolean {
	const inside = relative(realpathSync(dir), realpathSync(path));
	return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

/**
 * `nested` is how a release built with `bundledDependencies` installs: every dependency inside the
 * package. `hoisted` is the same release without them: dependencies beside the package.
 */
export type FakeLayout = "nested" | "hoisted";

export interface FakeInstall {
	readonly root: string;
	readonly packageDir: string;
	readonly entryPath: string;
	readonly agentDir: string;
	reinstall(build: string, layout?: FakeLayout): void;
	cleanup(): void;
}

function write(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
}

function writeDependency(
	modules: string,
	name: string,
	build: string,
	dependencies: Record<string, string> = {},
): void {
	write(join(modules, name, "package.json"), JSON.stringify({ name, version: build, dependencies }));
	write(join(modules, name, "index.js"), `module.exports = ${JSON.stringify(`${name}@${build}`)};\n`);
	write(join(modules, name, "index.d.ts"), "export {};\n");
}

function writeDependencies(modules: string, build: string): void {
	writeDependency(modules, "nested-dep", build);
	writeDependency(modules, "native-ext", build, { "native-helper": "*" });
	write(join(modules, "native-ext/prebuilds/native.node"), `native ${build}\n`);
	writeDependency(modules, "native-helper", build);
	writeDependency(modules, "skill-pkg", build);
	write(join(modules, "skill-pkg/src/skill/demo/SKILL.md"), `# demo skill ${build}\n`);
}

function writePackage(packageDir: string, globalModules: string, build: string, layout: FakeLayout): void {
	const dependencies = { "nested-dep": "*", "native-ext": "*", "skill-pkg": "*", "hoisted-ext": "*" };
	const bin = { senpi: "dist/bundle/cli.js" };
	write(
		join(packageDir, "package.json"),
		JSON.stringify({ name: "@code-yeongyu/senpi", version: build, bin, dependencies }),
	);
	write(join(packageDir, "dist/cli-main.js"), `export const unbundled = "${build}";\n`);
	write(join(packageDir, "dist/bundle/cli.js"), `import("./chunks/provider-${build}.js");\n`);
	write(join(packageDir, `dist/bundle/chunks/provider-${build}.js`), `export const build = "${build}";\n`);
	write(join(packageDir, "dist/bundle/grammar-X1.wasm"), `wasm ${build}\n`);
	write(
		join(packageDir, "dist/bundle/runtime-manifest.json"),
		JSON.stringify({ buildId: build, externals: ["hoisted-ext", "native-ext", "absent-optional"] }),
	);
	write(join(packageDir, "dist/modes/interactive/theme/dark.json"), "{}\n");
	write(join(packageDir, "docs/index.md"), `# ${build}\n`);
	write(join(packageDir, "dist/core/extensions/builtin/websearch.js"), "export default () => {};\n");
	writeDependencies(layout === "nested" ? join(packageDir, "node_modules") : globalModules, build);
}

/**
 * A global prefix laid out like `bun install -g`: the package under a scope, its dependencies
 * nested inside it or hoisted beside it, one dependency always hoisted, plus an agent directory
 * that holds the runtime snapshots.
 */
export function createFakeInstall(build = "build-a", layout: FakeLayout = "nested"): FakeInstall {
	const root = mkdtempSync(join(tmpdir(), "senpi-runtime-snapshot-"));
	const globalModules = join(root, "global/node_modules");
	const packageDir = join(globalModules, "@code-yeongyu/senpi");
	writeDependency(globalModules, "hoisted-ext", build);
	writePackage(packageDir, globalModules, build, layout);
	return {
		root,
		packageDir,
		entryPath: join(packageDir, "dist/bundle/cli.js"),
		agentDir: join(root, "agent"),
		reinstall(next, nextLayout = layout) {
			// A package manager replaces the whole prefix: every package it installed is rewritten.
			for (const name of [
				"@code-yeongyu",
				"hoisted-ext",
				"nested-dep",
				"native-ext",
				"native-helper",
				"skill-pkg",
			]) {
				rmSync(join(globalModules, name), { recursive: true, force: true });
			}
			writeDependency(globalModules, "hoisted-ext", next);
			writePackage(packageDir, globalModules, next, nextLayout);
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
