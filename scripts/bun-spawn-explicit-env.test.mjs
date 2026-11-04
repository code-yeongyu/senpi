import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Security contract (senpi#5519, omo#12157): under Bun, `delete process.env.X` never reaches the OS environment, and
// Bun.spawn / Bun.spawnSync with no `env` hand the child that OS environment - including the engine trust closure an
// adopted engine deleted. Every call in shipped sources must pass `env`. Bun.$ is exempt: it reads process.env.
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SCANNED = readdirSync(join(root, "packages"), { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => `packages/${entry.name}/src`)
	.filter((directory) => existsSync(join(root, directory)));
const SOURCE = /\.(?:[cm]?js|[cm]?ts)$/;
const CALL = /Bun\.spawn(?:Sync)?\(/g;

function* sources(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) yield* sources(path);
		else if (SOURCE.test(entry.name) && !entry.name.endsWith(".d.ts")) yield path;
	}
}

/** The argument text of the call whose `(` is at `open`, by parenthesis depth; source text, not a parse. */
function callArguments(text, open) {
	let depth = 0;
	for (let index = open; index < text.length; index++) {
		if (text[index] === "(") depth++;
		else if (text[index] === ")" && --depth === 0) return text.slice(open + 1, index);
	}
	return text.slice(open + 1);
}

function callsWithoutEnv(text) {
	const missing = [];
	for (const match of text.matchAll(CALL)) {
		const open = match.index + match[0].length - 1;
		if (!/\benv\b\s*[:,}]/.test(callArguments(text, open))) {
			missing.push(text.slice(0, match.index).split("\n").length);
		}
	}
	return missing;
}

test("the guard tells a call with env from one without", () => {
	assert.deepEqual(callsWithoutEnv('Bun.spawn(["sh"], { env: process.env, stdout: "pipe" })'), []);
	assert.deepEqual(callsWithoutEnv('Bun.spawn(["sh"], { env, stdout: "pipe" })'), []);
	assert.deepEqual(callsWithoutEnv('a()\nBun.spawnSync(["sh"], { stdout: "pipe" })'), [2]);
	assert.deepEqual(callsWithoutEnv('Bun.spawn(["sh", f(environment)])'), [1]);
});

test("every Bun.spawn / Bun.spawnSync in shipped sources passes an explicit env", () => {
	const offenders = [];
	for (const directory of SCANNED) {
		for (const file of sources(join(root, directory))) {
			for (const line of callsWithoutEnv(readFileSync(file, "utf8"))) offenders.push(`${relative(root, file)}:${line}`);
		}
	}
	assert.deepEqual(offenders, []);
});
