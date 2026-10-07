import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { prepareSenpiBundledWorkspaces } from "./prepare-senpi-bundled-workspaces.mjs";

let tempDir;
let originalLog;

beforeEach(() => {
	originalLog = console.log;
	console.log = () => {};
});

afterEach(() => {
	console.log = originalLog;
	if (tempDir) {
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function writeJson(path, value) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, undefined, "\t")}\n`);
}

function writeFile(path, contents = "") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}

function codingAgentPath(root, ...segments) {
	return join(root, "packages", "coding-agent", ...segments);
}

// A repository whose coding-agent declares the vendored client/protocol plus registry edges,
// and whose client/protocol builds import each other by package name.
function writeRepository(root) {
	writeJson(codingAgentPath(root, "package.json"), {
		name: "@code-yeongyu/senpi",
		version: "2026.7.22",
		files: ["dist", "README.md"],
		dependencies: {
			"@earendil-works/chord": "0.85.1",
			"@earendil-works/pi-ai": "^2026.7.22",
			"@earendil-works/pi-client": "^2026.7.22",
			"@earendil-works/pi-protocol": "^2026.7.22",
			typebox: "1.3.34",
		},
		bundleDependencies: ["@earendil-works/pi-ai"],
		bundledDependencies: ["@earendil-works/pi-ai"],
	});
	writeJson(join(root, "packages", "client", "package.json"), {
		name: "@earendil-works/pi-client",
		version: "2026.7.22",
		dependencies: { "@earendil-works/chord": "0.85.1", "@earendil-works/pi-protocol": "2026.7.22" },
	});
	writeJson(join(root, "packages", "protocol", "package.json"), {
		name: "@earendil-works/pi-protocol",
		version: "2026.7.22",
		dependencies: { "@earendil-works/chord": "0.85.1", typebox: "1.3.34" },
	});
	writeFile(join(root, "packages", "client", "dist", "index.js"), 'export * from "./client.js";\n');
	writeFile(join(root, "packages", "client", "dist", "index.d.ts"));
	writeFile(
		join(root, "packages", "client", "dist", "client.d.ts"),
		'import type { SessionSnapshot } from "@earendil-works/pi-protocol";\n',
	);
	writeFile(join(root, "packages", "protocol", "dist", "index.js"), "export const protocol = 1;\n");
	writeFile(join(root, "packages", "protocol", "dist", "index.d.ts"));
	writeFile(join(root, "packages", "protocol", "dist", "index.js.map"), "{}\n");
	writeFile(join(root, "packages", "client", "dist", "client.d.ts.map"), "{}\n");
	writeFile(
		codingAgentPath(root, "dist", "client", "remote-session.d.ts"),
		[
			'import type { PiClient } from "@earendil-works/pi-client";',
			"import type { SessionSnapshot } from '@earendil-works/pi-protocol';",
			"",
		].join("\n"),
	);
}

describe("prepareSenpiBundledWorkspaces", () => {
	it("vendors client and protocol and stages a registry-resolved manifest", () => {
		// Given: a stale vendor tree left behind by an earlier staging run.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-prepare-"));
		writeRepository(tempDir);
		writeFile(codingAgentPath(tempDir, "vendor", "stale", "index.js"));

		// When
		prepareSenpiBundledWorkspaces(tempDir);

		// Then: the built client/protocol output is vendored, the stale tree is gone, and
		// every emitted import of the unpublished names is a relative vendor path.
		assert.equal(existsSync(codingAgentPath(tempDir, "vendor", "stale")), false);
		// Sourcemaps reference unpublished sources and are never vendored (senpi#2362).
		assert.equal(existsSync(codingAgentPath(tempDir, "vendor", "pi-protocol", "index.js.map")), false);
		assert.equal(existsSync(codingAgentPath(tempDir, "vendor", "pi-client", "client.d.ts.map")), false);
		assert.equal(
			readFileSync(codingAgentPath(tempDir, "vendor", "pi-protocol", "index.js"), "utf8"),
			"export const protocol = 1;\n",
		);
		const declaration = readFileSync(codingAgentPath(tempDir, "dist", "client", "remote-session.d.ts"), "utf8");
		assert.match(declaration, /"\.\.\/\.\.\/vendor\/pi-client\/index\.js"/);
		assert.match(declaration, /'\.\.\/\.\.\/vendor\/pi-protocol\/index\.js'/);
		assert.match(
			readFileSync(codingAgentPath(tempDir, "vendor", "pi-client", "client.d.ts"), "utf8"),
			/"\.\.\/pi-protocol\/index\.js"/,
		);
		// ...and the manifest is the source list minus the vendored packages, with no
		// bundle fields and no staged dependency tree.
		const manifest = JSON.parse(readFileSync(codingAgentPath(tempDir, "package.json"), "utf8"));
		assert.deepEqual(manifest.dependencies, {
			"@earendil-works/chord": "0.85.1",
			"@earendil-works/pi-ai": "npm:@code-yeongyu/senpi-ai@2026.7.22",
			typebox: "1.3.34",
		});
		assert.deepEqual(manifest.files, ["dist", "README.md", "vendor"]);
		assert.equal(Object.hasOwn(manifest, "bundleDependencies"), false);
		assert.equal(Object.hasOwn(manifest, "bundledDependencies"), false);
		assert.equal(existsSync(codingAgentPath(tempDir, "node_modules")), false);
	});

	it("rejects unresolved client or protocol specifiers after rewriting", () => {
		// Given: a subpath import the whole-specifier rewrite cannot reach.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-vendor-specifier-leak-"));
		writeRepository(tempDir);
		writeFile(codingAgentPath(tempDir, "dist", "leak.js"), 'import "@earendil-works/pi-protocol/schemas";\n');

		// When / Then
		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/still references resolver-visible package @earendil-works\/pi-protocol/,
		);
	});

	it("rejects undeclared runtime dependencies required by vendored workspaces", () => {
		// Given: vendored code is not a package, so senpi must declare what it imports.
		tempDir = mkdtempSync(join(tmpdir(), "senpi-vendor-runtime-dependency-"));
		writeRepository(tempDir);
		const manifestPath = codingAgentPath(tempDir, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		delete manifest.dependencies.typebox;
		writeJson(manifestPath, manifest);

		// When / Then
		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/pi-protocol requires typebox, which is absent from @code-yeongyu\/senpi runtime dependencies/,
		);
	});

	it("fails before vendoring when a client or protocol build file is missing", () => {
		// Given
		tempDir = mkdtempSync(join(tmpdir(), "senpi-vendor-missing-build-"));
		writeRepository(tempDir);
		rmSync(join(tempDir, "packages", "client", "dist", "index.d.ts"));

		// When / Then
		assert.throws(
			() => prepareSenpiBundledWorkspaces(tempDir),
			/Missing .*client.dist.index\.d\.ts\. Run npm run build before preparing vendored workspaces\./,
		);
	});
});
