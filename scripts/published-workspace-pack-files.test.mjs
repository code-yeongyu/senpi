import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	assertPublishedWorkspacePackFiles,
	nativePrebuildFile,
	nativePrebuildTarget,
} from "./senpi-publish-pack-checks.mjs";

const AGENT_CORE = "@earendil-works/pi-agent-core";
const PTY = "@earendil-works/pi-pty";
const CODEMODE = "@code-yeongyu/senpi-codemode";
const AGENT_CORE_FILES = [
	"package.json",
	"dist/index.js",
	"assets/tree-sitter/javascript.wasm",
	"assets/tree-sitter/web-tree-sitter.wasm",
];
const PTY_LOADER_FILES = ["package.json", "dist/index.js", "native/index.js"];
const CODEMODE_FILES = ["package.json", "src/index.ts", "src/kernels/py/prelude.py", "README.md", "CHANGELOG.md", "LICENSE"];

function packed(paths, prefix = "package/") {
	return { files: paths.map((path) => ({ path: `${prefix}${path}` })) };
}

function without(paths, removed) {
	return paths.filter((path) => path !== removed);
}

let warnings;
let originalWarn;

beforeEach(() => {
	warnings = [];
	originalWarn = console.warn;
	console.warn = (message) => warnings.push(String(message));
});

afterEach(() => {
	console.warn = originalWarn;
});

describe("assertPublishedWorkspacePackFiles", () => {
	it("accepts each published alias tarball that carries its loader-visible files", () => {
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY);
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed(AGENT_CORE_FILES), AGENT_CORE));
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed([...PTY_LOADER_FILES, hostPrebuild], ""), PTY));
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed(CODEMODE_FILES), CODEMODE));
		assert.deepEqual(warnings, []);
	});

	for (const missing of ["assets/tree-sitter/javascript.wasm", "assets/tree-sitter/web-tree-sitter.wasm"]) {
		it(`rejects a senpi-agent-core tarball without ${missing} (issue #1800)`, () => {
			// Given: the agent-core dist imports its grammars as compile-time files.
			const tarball = packed(without(AGENT_CORE_FILES, missing));

			// When / Then
			assert.throws(
				() => assertPublishedWorkspacePackFiles(tarball, AGENT_CORE),
				new RegExp(`${AGENT_CORE} package tarball is missing loader-visible files: ${missing.replaceAll(".", "\\.")}$`),
			);
		});
	}

	it("rejects a senpi-pty tarball without its native loader", () => {
		// Given
		const tarball = packed([...without(PTY_LOADER_FILES, "native/index.js"), nativePrebuildFile(nativePrebuildTarget(), PTY)]);

		// When / Then
		assert.throws(() => assertPublishedWorkspacePackFiles(tarball, PTY), /missing loader-visible files: native\/index\.js$/);
	});

	it("rejects a senpi-codemode tarball without its python prelude", () => {
		// Given
		const tarball = packed(without(CODEMODE_FILES, "src/kernels/py/prelude.py"));

		// When / Then
		assert.throws(
			() => assertPublishedWorkspacePackFiles(tarball, CODEMODE),
			/missing loader-visible files: src\/kernels\/py\/prelude\.py$/,
		);
	});

	it("warns but passes when the host pty prebuild is missing (pipe fallback)", () => {
		// Given: every loader file is present, but no native prebuild.
		const hostPrebuild = nativePrebuildFile(nativePrebuildTarget(), PTY);

		// When / Then
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed(PTY_LOADER_FILES), PTY));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], new RegExp(`no native prebuild ${hostPrebuild.replaceAll(".", "\\.")}`));
	});

	for (const packageName of [AGENT_CORE, "@earendil-works/pi-telemetry"]) {
		it(`rejects a ${packageName} tarball that ships sourcemaps (senpi#2362)`, () => {
			// Given: every published package, not only senpi, must leave its maps out.
			const tarball = packed([...AGENT_CORE_FILES, "dist/index.js.map"]);

			// When / Then
			assert.throws(
				() => assertPublishedWorkspacePackFiles(tarball, packageName),
				/must not ship sourcemaps \(found 1, e\.g\. dist\/index\.js\.map\)/,
			);
		});
	}

	it("ignores packages outside the published workspace checks, including the vendored client and protocol", () => {
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed([]), "@earendil-works/pi-client"));
		assert.doesNotThrow(() => assertPublishedWorkspacePackFiles(packed([]), "@earendil-works/pi-protocol"));
	});

	it("rejects an unsupported native prebuild target", () => {
		assert.throws(() => nativePrebuildTarget("freebsd", "x64"), /Unsupported native prebuild target: freebsd-x64/);
	});
});
