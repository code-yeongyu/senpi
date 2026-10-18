import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

it("stages a usable release closure before adding the archive package manifest", () => {
	// Given a filesystem fixture with the release driver's real staging block.
	const root = mkdtempSync(join(tmpdir(), "senpi-release-staging-"));
	const agent = join(root, "packages/coding-agent");
	function file(path, content) {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	try {
		file("packages/coding-agent/package.json", JSON.stringify({ name: "release-fixture", version: "1.0.0" }));
		for (const path of [
			"packages/coding-agent/README.md", "packages/coding-agent/CHANGELOG.md",
			"packages/coding-agent/dist/modes/interactive/theme/theme.json",
			"packages/coding-agent/dist/modes/interactive/assets/icon.png",
			"packages/coding-agent/dist/core/export-html/template.html",
			"packages/coding-agent/docs/doc.md", "packages/coding-agent/examples/example.js",
			"node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm",
			"packages/tui/native/darwin/prebuilds/darwin-arm64/helper",
		]) {
			file(path, "fixture");
		}
		file("packages/senpi-codemode/package.json", JSON.stringify({
			name: "@code-yeongyu/senpi-codemode", files: ["index.js"], dependencies: { payload: "1.0.0" },
		}));
		file("packages/senpi-codemode/index.js", "module.exports = require('payload');");
		file("node_modules/payload/package.json", JSON.stringify({ name: "payload", version: "1.0.0" }));
		file("node_modules/payload/index.js", "module.exports = 'loaded payload';");
		mkdirSync(join(root, "scripts"));
		cpSync(resolve("scripts/copy-codemode-sidecar.mjs"), join(root, "scripts/copy-codemode-sidecar.mjs"));
		file("packages/coding-agent/src/core/extensions/loader.ts",
			readFileSync(resolve("packages/coding-agent/src/core/extensions/loader.ts"), "utf8"));
		const driver = readFileSync(resolve("scripts/build-binaries.sh"), "utf8");
		const start = driver.indexOf("# Copy shared files");
		const end = driver.indexOf("# Create archives");
		assert.ok(start !== -1 && end > start, "build-binaries.sh staging markers moved");
		const staging = driver.slice(start, end);
		const copier = staging.indexOf("node \"../../scripts/copy-codemode-sidecar.mjs\" \"$OUTPUT_DIR/$platform\"");
		assert.ok(copier !== -1, "staging block no longer runs the codemode sidecar copier");
		assert.ok(copier < staging.indexOf("cp package.json \"$OUTPUT_DIR/$platform/\""), "package.json is copied before the sidecar");
		mkdirSync(join(root, "release/darwin-arm64"), { recursive: true });
		// When the exact release staging commands run without compiling a binary.
		const result = spawnSync("bash", ["-c", `set -euo pipefail\nOUTPUT_DIR="$1"\nPLATFORMS=(darwin-arm64)\n${staging}`, "staging", join(root, "release").replaceAll("\\", "/")], {
			cwd: agent, encoding: "utf8", env: { ...process.env, SENPI_SIDECAR_EXCLUDE: "" },
		});
		// Then the archive manifest exists and the closure runs without its source install.
		assert.equal(result.error, undefined, `bash is required to run the release staging block: ${result.error?.message}`);
		assert.equal(result.status, 0, result.stderr);
		const output = join(root, "release/darwin-arm64");
		assert.equal(JSON.parse(readFileSync(join(output, "package.json"))).name, "release-fixture");
		rmSync(join(root, "node_modules"), { recursive: true });
		rmSync(join(root, "packages/senpi-codemode"), { recursive: true });
		assert.equal(createRequire(join(output, "entry.js"))("@code-yeongyu/senpi-codemode"), "loaded payload");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
