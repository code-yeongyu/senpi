#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILD_PHASES, cleanEnv, detectPackageManager, parseArgs } from "./build-all.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

describe("build-all", () => {
	it("uses an explicit package manager override", () => {
		// Given
		const args = parseArgs(["--pm", "bun"]);

		// When
		const pm = detectPackageManager({ npm_execpath: "/usr/local/bin/npm" }, args.pm);

		// Then
		assert.deepEqual(pm, { cmd: "bun", execpath: undefined });
	});

	it("keeps dependent packages in later parallel phases", () => {
		// Given
		const flattened = BUILD_PHASES.flat();

		// When
		const index = (pkg) => BUILD_PHASES.findIndex((phase) => phase.includes(pkg));

		// Then
		assert.deepEqual(flattened, [
			"packages/tui",
			"packages/pty",
			"packages/ai",
			"packages/agent",
			"packages/coding-agent",
			"packages/web-ui",
			"packages/orchestrator",
		]);
		assert.ok(index("packages/agent") > index("packages/ai"));
		assert.ok(index("packages/coding-agent") > index("packages/agent"));
		assert.ok(index("packages/web-ui") > index("packages/agent"));
		assert.ok(index("packages/orchestrator") > index("packages/coding-agent"));
	});

	it("builds pty beside tui in the first native-adjacent phase", () => {
		// Given
		const packageJson = JSON.parse(readFileSync(join(root, "packages/pty/package.json"), "utf8"));
		const phaseOne = BUILD_PHASES[0];

		// Then
		assert.equal(packageJson.name, "@earendil-works/pi-pty");
		assert.deepEqual(phaseOne, ["packages/tui", "packages/pty", "packages/ai"]);
	});

	it("wires the pty package export surface for workspace imports", () => {
		// Given
		const rootPackageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const packageJson = JSON.parse(readFileSync(join(root, "packages/pty/package.json"), "utf8"));

		// Then
		assert.ok(rootPackageJson.workspaces.includes("packages/pty"));
		assert.equal(packageJson.main, "./dist/index.js");
		assert.equal(packageJson.types, "./dist/index.d.ts");
		assert.deepEqual(packageJson.exports["."], {
			types: "./dist/index.d.ts",
			import: "./dist/index.js",
		});
		assert.deepEqual(packageJson.exports["./native"], {
			types: "./native/index.d.ts",
			import: "./native/index.js",
		});
		assert.ok(packageJson.files.includes("dist"));
		assert.ok(packageJson.files.includes("native"));
	});

	it("strips pnpm-only npm config from child environments", () => {
		// Given
		const env = {
			npm_config_node_linker: "hoisted",
			npm_config_registry: "https://registry.npmjs.org/",
		};

		// When
		const cleaned = cleanEnv(env);

		// Then
		assert.equal(cleaned.npm_config_node_linker, undefined);
		assert.equal(cleaned.npm_config_registry, "https://registry.npmjs.org/");
	});

	it("builds ai from committed catalog data without networked generation", () => {
		// Given
		const packageJson = JSON.parse(readFileSync(join(root, "packages/ai/package.json"), "utf8"));
		const scripts = packageJson.scripts;

		// When
		const buildScript = scripts.build;
		const prepublishScript = scripts.prepublishOnly;
		const ignoreCheck = spawnSync("git", ["check-ignore", "packages/ai/src/providers/data/anthropic.json"], {
			cwd: root,
		});

		// Then
		assert.equal(scripts.prebuild, undefined);
		assert.doesNotMatch(buildScript, /generate-models/);
		assert.match(buildScript, /^tsgo -p tsconfig\.build\.json/);
		assert.match(buildScript, /shx chmod \+x dist\/cli\.js/);
		assert.match(buildScript, /shx cp -r src\/providers\/data dist\/providers\/data$/);
		assert.match(scripts["generate-models"], /generate-models\.ts/);
		assert.match(prepublishScript, /generate-models\.ts/);
		assert.match(prepublishScript, /generate-image-models\.ts/);
		assert.notEqual(ignoreCheck.status, 0);
		assert.ok(readdirSync(join(root, "packages/ai/src/providers/data")).some((file) => file.endsWith(".json")));
	});
});
