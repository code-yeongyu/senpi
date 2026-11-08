#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const code = "senpi-egress(no-module-state)";

const lint = (relativePath, source) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-egress-rule-")));
	try {
		copyFileSync(join(root, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
		symlinkSync(join(root, "scripts"), join(dir, "scripts"), "dir");
		const file = join(dir, relativePath);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, source);
		const result = spawnSync(
			process.execPath,
			[join(root, "node_modules", "oxlint", "bin", "oxlint"), "-c", ".oxlintrc.json", "-f", "json", file],
			{ cwd: dir, encoding: "utf8" },
		);
		assert.ok(result.status === 0 || result.status === 1, result.stderr);
		return JSON.parse(result.stdout).diagnostics.filter((diagnostic) => diagnostic.code === code);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const egress = (source) => lint("packages/coding-agent/src/core/egress/sample.ts", source);

describe("senpi-egress/no-module-state", () => {
	for (const [label, source] of [
		["a top-level let", "let cache = 0;\nexport const read = () => cache;\n"],
		["a top-level var", "var cache = 0;\nexport const read = () => cache;\n"],
		["a const Map", "const leases = new Map<string, string>();\nexport const size = () => leases.size;\n"],
		["a const Set", "const seen = new Set<string>();\nexport const has = (k: string) => seen.has(k);\n"],
		["a const WeakMap", "const byKey = new WeakMap<object, string>();\nexport const get = (k: object) => byKey.get(k);\n"],
		["a const WeakRef", "const last = new WeakRef({});\nexport const deref = () => last.deref();\n"],
		["an object literal with a member assignment", "const config = { account: '' };\nexport const bind = (a: string) => {\n\tconfig.account = a;\n};\n"],
		["an object literal with a nested member assignment", "const config = { inner: { account: '' } };\nexport const bind = (a: string) => {\n\tconfig.inner.account = a;\n};\n"],
		["an object literal with a computed member assignment", "const byTenant: Record<string, string> = {};\nexport const bind = (t: string, k: string) => {\n\tbyTenant[t] = k;\n};\n"],
		["an array literal with push", "const patterns: string[] = [];\nexport const add = (p: string) => patterns.push(p);\n"],
		["an array literal with splice", "const patterns = ['a'];\nexport const drop = () => patterns.splice(0, 1);\n"],
		["an array literal behind `as const` with push", "const names = ['a'] as const;\nexport const add = () => (names as unknown as string[]).push('b');\n"],
		["an object literal with a set call", "const registry = { slots: new Map<string, string>() };\nexport const put = (k: string) => registry.slots.set(k, k);\n"],
		["an object literal with delete", "const cache: Record<string, string> = { a: '' };\nexport const evict = (k: string) => {\n\tdelete cache[k];\n};\n"],
		["an object literal with an update", "const counters = { calls: 0 };\nexport const tick = () => {\n\tcounters.calls++;\n};\n"],
		["an object literal escaping into Object.assign", "const config = { account: '' };\nexport const bind = (a: string) => Object.assign(config, { account: a });\n"],
		["an object literal escaping into Reflect.set", "const config = { account: '' };\nexport const bind = (a: string) => Reflect.set(config, 'account', a);\n"],
		["an object literal aliased twice then mutated", "const config = { account: '' };\nexport const bind = (a: string) => {\n\tconst first = config;\n\tconst second = first;\n\tsecond.account = a;\n};\n"],
		["an object literal aliased then mutated", "const config = { account: '' };\nexport const bind = (a: string) => {\n\tconst alias = config;\n\talias.account = a;\n};\n"],
		["an exported let", "export let current = 0;\n"],
		["an exception marker with an unknown name", "// no-module-state: tenant-cache\nlet cache = 0;\nexport const read = () => cache;\n"],
	]) {
		it(`reports ${label}`, () => {
			assert.equal(egress(source).length, 1);
		});
	}

	for (const [label, source] of [
		["an unmutated object literal", "const config = { account: 'x' };\nexport const read = () => config.account;\n"],
		["an unmutated array literal", "const names = ['a', 'b'];\nexport const has = (n: string) => names.includes(n);\n"],
		["an unmutated `as const` array", "const names = ['a', 'b'] as const;\nexport const read = () => names;\n"],
		["an unmutated Readonly record", "const table: Readonly<Record<string, number>> = { a: 1 };\nexport const read = (k: string) => table[k];\n"],
		["an unmutated nested literal", "const nested = { a: { b: [1, 2] } };\nexport const read = () => nested.a.b.length;\n"],
		["an exported unmutated literal", "export const TABLE = { a: 1 } as const;\n"],
		["a literal stored into another container", "const MARK = { secret: true };\nexport const tag = (o: Record<string, object>, k: string) => {\n\to[k] = MARK;\n};\n"],
		["a literal passed to a non-mutating call", "const keys = ['a'] as const;\nexport const check = (o: object) => Object.keys(o).every((k) => keys.includes(k as 'a'));\n"],
		["a primitive const", "const LIMIT = 3;\nexport const read = () => LIMIT;\n"],
		["a const from a call", "const MARK = Symbol.for('x');\nexport const read = () => MARK;\n"],
		["state inside a class instance", "export class Source {\n\tprivate readonly leases = new Map<string, string>();\n\tsize() {\n\t\treturn this.leases.size;\n\t}\n}\n"],
		["state inside a function", "export function make() {\n\tconst seen = new Set<string>();\n\treturn () => seen.size;\n}\n"],
		["the console-redactor-install exception", "import { AsyncLocalStorage } from 'node:async_hooks';\n// no-module-state: console-redactor-install\nconst context = new AsyncLocalStorage<string>();\nexport const store = () => context.getStore();\n"],
		["the sealed-window-counter exception", "// no-module-state: sealed-window-counter\nlet windows = 0;\nexport const count = () => windows;\n"],
	]) {
		it(`allows ${label}`, () => {
			assert.deepEqual(egress(source), []);
		});
	}

	it("applies only under src/core/egress", () => {
		assert.deepEqual(lint("packages/coding-agent/src/core/other.ts", "let cache = 0;\nexport const read = () => cache;\n"), []);
	});

	it("passes the shipped egress sources", () => {
		const result = spawnSync(
			process.execPath,
			[join(root, "node_modules", "oxlint", "bin", "oxlint"), "-c", ".oxlintrc.json", "-f", "json", "packages/coding-agent/src/core/egress"],
			{ cwd: root, encoding: "utf8" },
		);
		assert.ok(result.status === 0 || result.status === 1, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).diagnostics.filter((diagnostic) => diagnostic.code === code), []);
	});
});
