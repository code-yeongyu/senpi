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
const oxlint = join(root, "node_modules", "oxlint", "bin", "oxlint");

const lint = (relativePath, source) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-egress-rule-")));
	try {
		copyFileSync(join(root, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
		symlinkSync(join(root, "scripts"), join(dir, "scripts"), "dir");
		const file = join(dir, relativePath);
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, source);
		const result = spawnSync(process.execPath, [oxlint, "-c", ".oxlintrc.json", "-f", "json", file], {
			cwd: dir,
			encoding: "utf8",
		});
		assert.ok(result.status === 0 || result.status === 1, result.stderr);
		return JSON.parse(result.stdout).diagnostics.filter((diagnostic) => diagnostic.code === code);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

const egress = (source) => lint("packages/coding-agent/src/core/egress/sample.ts", source);

// r11.1 R8 "Mutants (red, named)" plus the R7 lint mutants: each must be reported.
const MUTANTS = [
	["const cache = createCache()", "declare function createCache(): object;\nconst cache = createCache();\nexport const read = () => cache;\n"],
	["const pool = new LRU()", "declare class LRU {}\nconst pool = new LRU();\nexport const read = () => pool;\n"],
	["const seen = [] without as const", "const seen: string[] = [];\nexport const read = () => seen;\n"],
	["const RE = /x/g", "const RE = /x/g;\nexport const read = () => RE;\n"],
	["const RE = /x/y", "const RE = /x/y;\nexport const read = () => RE;\n"],
	["const BYTES = new Uint8Array([0])", "const BYTES = new Uint8Array([0]);\nexport const read = () => BYTES;\n"],
	["const BUF = Buffer.from('x')", "const BUF = Buffer.from('x');\nexport const read = () => BUF;\n"],
	["Object.freeze({ nested: {} }) without as const", "const T = Object.freeze({ nested: {} });\nexport const read = () => T;\n"],
	["const K = [...].flatMap(...)", "const K = ['a'].flatMap((x) => [x]);\nexport const read = () => K;\n"],
	["static cache = new Map() on a class", "export class Holder {\n\tstatic cache = new Map<string, string>();\n}\n"],
	["const x = await load()", "declare function load(): Promise<number>;\nconst x = await load();\nexport const read = () => x;\n"],
	["module-level let", "let current = 0;\nexport const read = () => current;\n"],
	["module-level var", "var current = 0;\nexport const read = () => current;\n"],
	["exported let", "export let current = 0;\n"],
	["Readonly<> literal without as const", "const X: Readonly<Record<string, string>> = { a: 'b' };\nexport const read = () => X;\n"],
	["readonly array literal without as const", "const X: readonly string[] = ['a'];\nexport const read = () => X;\n"],
	["new Set typed ReadonlySet", "const S: ReadonlySet<string> = new Set(['a']);\nexport const read = () => S;\n"],
	["empty new Map()", "const M = new Map<string, string>();\nexport const read = () => M;\n"],
	["new WeakMap()", "const W = new WeakMap<object, string>();\nexport const read = () => W;\n"],
	["new WeakSet()", "const W = new WeakSet<object>();\nexport const read = () => W;\n"],
	["new WeakRef()", "const W = new WeakRef({});\nexport const read = () => W;\n"],
	["const cache = {} later written", "const cache: Record<string, string> = {};\nexport const put = (k: string, v: string) => {\n\tcache[k] = v;\n};\n"],
	["destructuring from a call", "declare function load(): { a: number };\nconst { a } = load();\nexport const read = () => a;\n"],
	["JSON.parse", "const CONFIG = JSON.parse('{}');\nexport const read = () => CONFIG;\n"],
	["as const literal holding a mutable call result", "declare function make(): object;\nconst T = { inner: make() } as const;\nexport const read = () => T;\n"],
	["new TextEncoder with arguments shape", "declare class TextEncoderStream {}\nconst S = new TextEncoderStream();\nexport const read = () => S;\n"],
	["an as const table referencing a non-egress import", "import { TABLE } from '../other.ts';\nconst T = { inner: TABLE } as const;\nexport const read = () => T;\n"],
	["Type.* from a non-TypeBox import", "import { Type } from './local-type.ts';\nconst Schema = Type.Object({});\nexport const read = () => Schema;\n"],
];

const PASSES = [
	["primitive literals", "const N = 3;\nconst S = 'x';\nconst B = true;\nconst Z = null;\nconst U = undefined;\nconst BIG = 1n;\nexport const read = () => [N, S, B, Z, U, BIG];\n"],
	["templates and operators over primitives", "const A = 4;\nconst KB = A * 1024;\nconst LABEL = `v${A}`;\nconst NEG = -A;\nconst C = A > 2 ? 'x' : 'y';\nexport const read = () => [KB, LABEL, NEG, C];\n"],
	["a regex without flags", "const HEX = /^[0-9a-f]+$/;\nexport const read = (s: string) => HEX.test(s);\n"],
	["a regex with u/i flags only", "const HEX = /^[0-9a-f]+$/iu;\nexport const read = (s: string) => HEX.test(s);\n"],
	["Symbol() and Symbol.for()", "const A = Symbol('a');\nconst B = Symbol.for('b');\nexport const read = () => [A, B];\n"],
	["Number/String/Math over primitives", "const A = Number('3');\nconst B = String(4);\nconst C = Math.max(1, 2);\nconst D = parseInt('7', 10);\nexport const read = () => [A, B, C, D];\n"],
	["declare const brand", "declare const brand: unique symbol;\nexport type Branded = string & { [brand]: true };\n"],
	["an as const array", "const NAMES = ['a', 'b'] as const;\nexport const read = () => NAMES;\n"],
	["an as const object with a nested reference to another as const", "const INNER = { a: 1 } as const;\nconst OUTER = { inner: INNER, list: ['x'] } as const;\nexport const read = () => OUTER;\n"],
	["as const satisfies T with a method property", "interface Shape { readonly k: string; get(): number }\nconst T = { k: 'v', get() { return 1; } } as const satisfies Shape;\nexport const read = () => T;\n"],
	["an as const table passed to a readonly helper", "const KEYS = ['a', 'b'] as const;\nfunction hasOnly(o: object, keys: readonly string[]) {\n\treturn Object.keys(o).every((k) => keys.includes(k));\n}\nexport const ok = (o: object) => hasOnly(o, KEYS);\n"],
	["an as const table referencing a sibling egress import", "import { TABLE } from './other.ts';\nconst T = { inner: TABLE } as const;\nexport const read = () => T;\n"],
	["Object.freeze over a flat literal", "const T = Object.freeze({ a: 1, b: 'x' });\nexport const read = () => T;\n"],
	["Object.freeze over an as const literal", "const T = Object.freeze({ inner: { a: 1 } } as const);\nexport const read = () => T;\n"],
	["destructuring from an as const table", "const TABLE = { a: 1, b: 2 } as const;\nconst { a, b } = TABLE;\nexport const read = () => a + b;\n"],
	["functions, arrows and classes", "const read = () => 1;\nconst Box = class {};\nexport function f() {\n\treturn 1;\n}\nexport class C {\n\tstatic readonly LIMIT = 3;\n}\nexport { read, Box };\n"],
	["enum and type-only forms", "export enum Kind {\n\tA,\n\tB,\n}\nexport type T = string;\nexport interface I {\n\tx: number;\n}\n"],
	["new TextEncoder() and new TextDecoder()", "const encoder = new TextEncoder();\nconst decoder = new TextDecoder();\nexport const read = () => [encoder, decoder];\n"],
	["a TypeBox schema and its compiled validator", "import { Type } from 'typebox';\nimport { Compile } from 'typebox/compile';\nconst Schema = Type.Object({ a: Type.String() });\nconst check = Compile(Schema);\nexport const read = () => [Schema, check];\n"],
	["state inside a class instance", "export class Source {\n\tprivate readonly leases = new Map<string, string>();\n\tsize() {\n\t\treturn this.leases.size;\n\t}\n}\n"],
	["state inside a function", "export function make() {\n\tconst seen = new Set<string>();\n\treturn () => seen.size;\n}\n"],
	["the console-redactor-install marker", "import { AsyncLocalStorage } from 'node:async_hooks';\n// no-module-state: console-redactor-install\nconst context = new AsyncLocalStorage<string>();\nexport const store = () => context.getStore();\n"],
	["the sealed-window-counter marker", "// no-module-state: sealed-window-counter\nlet windows = 0;\nexport const count = () => windows;\n"],
];

describe("senpi-egress/no-module-state (r11.1 R8)", () => {
	for (const [label, source] of MUTANTS) {
		it(`reports ${label}`, () => {
			assert.equal(egress(source).length, 1, source);
		});
	}

	for (const [label, source] of PASSES) {
		it(`allows ${label}`, () => {
			assert.deepEqual(egress(source), [], source);
		});
	}

	it("reports an inline marker with an unlisted name, and keeps the binding an error", () => {
		const hits = egress("// no-module-state: tenant-cache\nlet cache = 0;\nexport const read = () => cache;\n");
		assert.equal(hits.length, 2);
	});

	it("reports an alias of a non-exempt binding as well as the binding", () => {
		const hits = egress("declare function make(): object;\nconst A = make();\nconst B = A;\nexport const read = () => B;\n");
		assert.deepEqual(
			hits.map((hit) => hit.labels[0].span.line),
			[2, 3],
		);
	});

	it("applies only under src/core/egress", () => {
		assert.deepEqual(lint("packages/coding-agent/src/core/other.ts", "let cache = 0;\nexport const read = () => cache;\n"), []);
	});

	it("passes the shipped egress sources", () => {
		const result = spawnSync(process.execPath, [oxlint, "-c", ".oxlintrc.json", "-f", "json", "packages/coding-agent/src/core/egress"], {
			cwd: root,
			encoding: "utf8",
		});
		assert.ok(result.status === 0 || result.status === 1, result.stderr);
		assert.deepEqual(
			JSON.parse(result.stdout).diagnostics.filter((diagnostic) => diagnostic.code === code),
			[],
		);
	});
});
