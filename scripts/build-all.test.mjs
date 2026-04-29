#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILD_PHASES, cleanEnv, detectPackageManager, parseArgs } from "./build-all.mjs";

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
			"packages/ai",
			"packages/agent",
			"packages/coding-agent",
			"packages/web-ui",
			"packages/pods",
			"packages/mom",
		]);
		assert.ok(index("packages/agent") > index("packages/ai"));
		assert.ok(index("packages/coding-agent") > index("packages/agent"));
		assert.ok(index("packages/mom") > index("packages/coding-agent"));
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
});
