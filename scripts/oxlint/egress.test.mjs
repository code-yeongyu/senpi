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
	["a var inside a top-level if", "declare const flag: boolean;\nif (flag) {\n\tvar leaked = new Map<string, string>();\n}\nexport const read = () => leaked;\n"],
	["a var inside a top-level bare block", "{\n\tvar leaked = new Map<string, string>();\n}\nexport const read = () => leaked;\n"],
	["a top-level try block", "try {\n\tvar leaked = new Map<string, string>();\n} catch {}\nexport const read = () => leaked;\n"],
	["a top-level for loop", "for (const k of ['a']) {\n\tvar leaked = new Map<string, string>([[k, k]]);\n}\nexport const read = () => leaked;\n"],
	["a mutable static primitive counter", "export class C {\n\tstatic n = 0;\n\tstatic bump() {\n\t\treturn ++this.n;\n\t}\n}\n"],
	["a private mutable static primitive", "export class C {\n\tstatic #n = 0;\n\tstatic bump() {\n\t\treturn ++C.#n;\n\t}\n}\n"],
	["a static accessor with a primitive", "export class C {\n\tstatic accessor n = 0;\n}\n"],
	["export default new Map()", "export default new Map<string, string>();\n"],
	["a cache assigned onto a function", "export function f() {\n\treturn 1;\n}\nf.cache = new Map<string, string>();\n"],
	["a cache assigned onto an arrow", "export const helper = () => 1;\nObject.assign(helper, { cache: new Map<string, string>() });\n"],
	["static accessor cache", "export class Holder {\n\tstatic accessor cache = new Map<string, string>();\n}\n"],
	["a static block filling a declared static", "export class Holder {\n\tdeclare static cache: Map<string, string>;\n\tstatic {\n\t\tHolder.cache = new Map();\n\t}\n}\n"],
	["as const under a Readonly<> annotation (shallow, nested writes still compile)", "const T: Readonly<{ inner: { a: string } }> = { inner: { a: 'x' } } as const;\nexport const read = () => T;\n"],
	["as const under a readonly array annotation", "const L: readonly string[] = ['a'] as const;\nexport const read = () => L;\n"],
	["as const under a writable annotation", "const T: { a: string } = { a: 'x' } as const;\nexport const read = () => T;\n"],
	["a write through a cast to an as const table", "const T = ['a'] as const;\nexport const add = () => (T as unknown as string[]).push('b');\n"],
	["a member write to an as const table under a readonly annotation", "const T: Readonly<{ inner: { a: string } }> = { inner: { a: 'x' } } as const;\nexport const set = (v: string) => {\n\t(T.inner as { a: string }).a = v;\n};\n"],
	["Reflect.set on an as const table", "const T = { a: 'x' } as const;\nexport const set = (v: string) => Reflect.set(T, 'a', v);\n"],
	["a marker reused on the wrong binding", "// no-module-state: sealed-window-counter\nconst cache = new Map<string, string>();\nexport const read = () => cache;\n"],
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
	["as const satisfies T (the R8 form for a declared type)", "const T = { a: 'x' } as const satisfies Readonly<Record<string, string>>;\nconst L = ['a'] as const satisfies readonly string[];\nexport const read = () => [T.a, L[0]];\n"],
	["void of an identifier at module scope", "const read = () => 1;\nvoid read;\n"],
	["export default of a function", "export default function run() {\n\treturn 1;\n}\n"],
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

	it("allows each named marker only on its own file and binding", () => {
		const file = "packages/coding-agent/src/core/egress/console-redactor.ts";
		const ok = "import { AsyncLocalStorage } from 'node:async_hooks';\n// no-module-state: console-redactor-install\nconst sealedContext = new AsyncLocalStorage<string>();\n// no-module-state: sealed-window-counter\nlet sealedWindows = 0;\nexport const read = () => [sealedContext.getStore(), sealedWindows];\n";
		assert.deepEqual(lint(file, ok), []);
		const elsewhere = "// no-module-state: sealed-window-counter\nlet sealedWindows = 0;\nexport const read = () => sealedWindows;\n";
		assert.equal(egress(elsewhere).length, 1);
		const renamed = "// no-module-state: sealed-window-counter\nlet windows = 0;\nexport const read = () => windows;\n";
		assert.equal(lint(file, renamed).length, 1);
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
