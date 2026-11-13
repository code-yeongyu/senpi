#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertRegistryPackagesKnown } from "./npm-registry.mjs";
import { registryPackageNames } from "./registry-packages.mjs";

// senpi#6636: npm trusted publishing cannot do a package's first publish, so a release must refuse before its test
// suite, tag or first `npm publish` when a publish-set name is unknown to the registry.

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const UNKNOWN = "@code-yeongyu/senpi-realm-registry";
const publishSet = [...registryPackageNames.values()];

describe("assertRegistryPackagesKnown (injected lookup)", () => {
	it("refuses with the unknown name and no known one, after asking about every publish-set name", () => {
		const asked = [];
		const lookup = (name) => {
			asked.push(name);
			return name === UNKNOWN ? null : JSON.stringify(name);
		};
		assert.throws(
			() => assertRegistryPackagesKnown(publishSet, lookup),
			(error) => {
				assert.match(error.message, new RegExp(UNKNOWN.replace("/", "\\/")));
				for (const name of publishSet.filter((name) => name !== UNKNOWN)) {
					assert.doesNotMatch(error.message, new RegExp(`${name.replace("/", "\\/")}(?![-\\w])`));
				}
				return true;
			},
		);
		assert.deepEqual(asked, publishSet);
	});

	it("lists every unknown name when two are unknown", () => {
		const unknown = [UNKNOWN, "@code-yeongyu/senpi-codemode"];
		assert.throws(
			() => assertRegistryPackagesKnown(publishSet, (name) => (unknown.includes(name) ? null : JSON.stringify(name))),
			(error) => unknown.every((name) => error.message.includes(name)),
		);
	});

	it("passes when every name is known", () => {
		assert.doesNotThrow(() => assertRegistryPackagesKnown(publishSet, (name) => JSON.stringify(name)));
	});

	it("lets a registry failure through as its own error, never as known or unknown", () => {
		const outage = new Error("Failed to query @code-yeongyu/senpi-ai\nnpm error code ETIMEDOUT");
		assert.throws(
			() =>
				assertRegistryPackagesKnown(publishSet, () => {
					throw outage;
				}),
			(error) => error === outage,
		);
	});
});

/** A PATH holding stub `npm` and `git` that log their argv; `npm view` answers per `registry` ("unknown" | "error"). */
function withStubs(registry, run) {
	const root = mkdtempSync(join(tmpdir(), "senpi-6636-"));
	const bin = join(root, "bin");
	const calls = join(root, "commands.jsonl");
	mkdirSync(bin);
	for (const name of ["npm", "git"]) {
		const body = `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(name)}, ...args]) + "\\n");
if (${JSON.stringify(name)} === "git" && args[0] === "branch") process.stdout.write("main\\n");
if (${JSON.stringify(name)} === "npm" && args[0] === "view") {
	if (${JSON.stringify(registry)} === "error") {
		process.stderr.write("npm error code ETIMEDOUT\\n");
		process.exit(1);
	}
	if (args[1] === ${JSON.stringify(UNKNOWN)}) {
		process.stderr.write("npm error code E404\\nnpm error 404 Not Found - GET https://registry.npmjs.org/x\\n");
		process.exit(1);
	}
	process.stdout.write(JSON.stringify(args[1]) + "\\n");
}
`;
		const runner = join(bin, `${name}.mjs`);
		writeFileSync(runner, body);
		if (process.platform === "win32") {
			writeFileSync(join(bin, `${name}.cmd`), `@"${process.execPath}" "${runner}" %*\r\n`);
		} else {
			writeFileSync(join(bin, name), `#!${process.execPath}\n${body}`);
			chmodSync(join(bin, name), 0o755);
		}
	}
	const env = {
		...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key))),
		PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
	};
	const commands = () =>
		existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
	try {
		return run({ root, env, commands });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

const runRelease = ({ root, env }) =>
	spawnSync(process.execPath, [join(repoRoot, "scripts", "release.mjs"), "--version", "2026.11.13-9", "--force-tests"], {
		cwd: root,
		env,
		encoding: "utf8",
		timeout: 15000,
	});

const spendsOrShips = (args) =>
	(args[0] === "npm" && args[1] === "run") || (args[0] === "git" && ["tag", "push", "commit"].includes(args[1]));

describe("release.mjs registry preflight", () => {
	it("refuses an unknown publish-set name before the suite, any tag and any push", () => {
		withStubs("unknown", (stub) => {
			const result = runRelease(stub);
			assert.equal(result.status, 1, result.stderr);
			assert.match(result.stderr, /@code-yeongyu\/senpi-realm-registry/);
			assert.deepEqual(stub.commands().filter(spendsOrShips), []);
		});
	});

	it("stops on a registry failure with that failure, not as an unknown package", () => {
		withStubs("error", (stub) => {
			const result = runRelease(stub);
			assert.equal(result.status, 1, result.stderr);
			assert.doesNotMatch(result.stderr, /@code-yeongyu\/senpi-realm-registry/);
			assert.deepEqual(stub.commands().filter(spendsOrShips), []);
		});
	});
});

describe("publish.mjs registry preflight", () => {
	it("refuses an unknown publish-set name with zero npm publish calls", () => {
		withStubs("unknown", ({ env, commands }) => {
			const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "publish.mjs")], {
				cwd: repoRoot,
				env: { ...env, GITHUB_ACTIONS: "true" },
				encoding: "utf8",
				timeout: 15000,
			});
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /@code-yeongyu\/senpi-realm-registry/);
			assert.deepEqual(
				commands().filter((args) => args[0] === "npm" && (args[1] === "publish" || args[1] === "pack")),
				[],
			);
			assert.doesNotMatch(result.stdout, /Publishing senpi packages/);
		});
	});
});
