import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// senpi#6497: the MCP SDK parses remote-server JSON-RPC with schemas built on whatever zod its install layout
// reaches. A hoisted zod 3.25.x answers `zod/v4` with a 4.0.0 core. The root `overrides` pin the SDK's zod,
// and every npm-driven build (the release bundle, `npm ci` + `bun build --compile` for the standalone
// binaries, the coding-agent install lock) resolves through the lockfiles below, so the pin has to be
// effective THERE, not only in package.json.

const root = join(import.meta.dirname, "..");
const MCP_SDK = "node_modules/@modelcontextprotocol/sdk";

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Node's resolution walk over lockfile paths: `<from>/node_modules/<name>`, then each enclosing node_modules. */
function resolveLockDependency(lockPackages, from, name) {
	let dir = from;
	for (;;) {
		const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
		if (lockPackages[candidate]) return { path: candidate, ...lockPackages[candidate] };
		if (dir === "") return undefined;
		const index = dir.lastIndexOf("node_modules/");
		dir = index <= 0 ? "" : dir.slice(0, index).replace(/\/$/, "");
	}
}

describe("MCP SDK zod pin in the lockfiles", () => {
	const rootManifest = readJson(join(root, "package.json"));
	const pinned = rootManifest.overrides["@modelcontextprotocol/sdk"].zod;

	it("pins the zod coding-agent depends on", () => {
		assert.equal(pinned, readJson(join(root, "packages", "coding-agent", "package.json")).dependencies.zod);
	});

	for (const lockPath of ["package-lock.json", "packages/coding-agent/install-lock/package-lock.json"]) {
		it(`${lockPath} resolves the MCP SDK's zod to the pinned version`, () => {
			const lock = readJson(join(root, lockPath));
			assert.ok(lock.packages[MCP_SDK], `${lockPath} has no ${MCP_SDK} entry`);
			const zod = resolveLockDependency(lock.packages, MCP_SDK, "zod");
			assert.ok(zod, `${lockPath} resolves no zod for the MCP SDK`);
			assert.equal(zod.version, pinned, `${lockPath}: ${zod.path} is ${zod.version}`);
		});
	}
});

describe("resolveLockDependency", () => {
	it("prefers the nested copy and falls back through every enclosing node_modules", () => {
		const packages = {
			"node_modules/zod": { version: "3.25.76" },
			"node_modules/a": {},
			"node_modules/a/node_modules/zod": { version: "4.6.7" },
			"node_modules/@s/b": {},
			"packages/w": {},
			"packages/w/node_modules/zod": { version: "4.6.7" },
		};
		assert.equal(resolveLockDependency(packages, "node_modules/a", "zod").path, "node_modules/a/node_modules/zod");
		assert.equal(resolveLockDependency(packages, "node_modules/@s/b", "zod").path, "node_modules/zod");
		assert.equal(resolveLockDependency(packages, "node_modules/a/node_modules/c", "zod").path, "node_modules/a/node_modules/zod");
		assert.equal(resolveLockDependency(packages, "packages/w", "zod").path, "packages/w/node_modules/zod");
		assert.equal(resolveLockDependency(packages, "packages/w", "missing"), undefined);
	});
});
