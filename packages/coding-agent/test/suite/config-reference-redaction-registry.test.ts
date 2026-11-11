/**
 * omo#12965: senpi can be loaded more than once in one process (the bundle's shared chunk, its session-worker entry
 * and the SDK graph each carry `core/config-reference-redaction.ts`), so the values config references resolved to
 * live in one process-wide registry that every copy reads and writes. Each case runs in a FRESH realm (a child Node
 * process importing two byte-identical copies of the module), because the registry is pinned and add-only: nothing
 * in the test realm could reset it between cases, and a planted slot must exist before the first copy evaluates.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../../src/core/config-reference-redaction.ts", import.meta.url));
const SLOT_KEY = "@code-yeongyu/senpi/config-reference-redaction/v1";
const SLOT_ERROR = "SENPI_REDACTION_SLOT_INCOMPATIBLE";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inFreshRealm(body: string): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-redaction-slot-"));
	roots.push(root);
	for (const copy of ["a", "b"]) {
		mkdirSync(join(root, copy));
		copyFileSync(SOURCE, join(root, copy, "redaction.ts"));
	}
	writeFileSync(
		join(root, "main.mjs"),
		[
			`const KEY = Symbol.for(${JSON.stringify(SLOT_KEY)});`,
			'const load = (copy) => import("./" + copy + "/redaction.ts");',
			`const out = await (async () => {\n${body}\n})();`,
			"process.stdout.write(JSON.stringify(out));",
		].join("\n"),
	);
	const run = spawnSync(process.execPath, [join(root, "main.mjs")], { encoding: "utf8", timeout: 20_000 });
	if (run.status !== 0) throw new Error(`fresh realm exited ${String(run.status)}: ${run.stderr}`);
	return JSON.parse(run.stdout) as Record<string, unknown>;
}

const importOutcome = `
try {
	await load("a");
	return { imported: true };
} catch (error) {
	return { imported: false, name: error.name, code: error.code, message: error.message };
}`;

describe("process-wide registry of resolved reference values (omo#12965)", () => {
	it("lets two copies of the module redact each other's values, including values added after a copy cached its forms", () => {
		const out = inFreshRealm(`
const a = await load("a");
const b = await load("b");
b.redactResolvedReferenceValues("warm the forms cache of copy b");
a.rememberResolvedReferenceValue("marker-a-12965-qv7k");
const aToB = b.redactResolvedReferenceValues("x marker-a-12965-qv7k y");
b.rememberResolvedReferenceValue("marker-b-12965-zp4m");
const bToA = a.redactResolvedReferenceValues("x marker-b-12965-zp4m y");
a.rememberResolvedReferenceValue("marker-late-12965-r2d2");
const late = b.redactResolvedReferenceValues("x marker-late-12965-r2d2 y");
const data = b.redactResolvedReferenceData({ nested: ["marker-a-12965-qv7k"] });
return { distinct: a !== b && a.redactResolvedReferenceValues !== b.redactResolvedReferenceValues, aToB, bToA, late, data };`);

		expect(out).toEqual({
			distinct: true,
			aToB: "x <redacted> y",
			bToA: "x <redacted> y",
			late: "x <redacted> y",
			data: { nested: ["<redacted>"] },
		});
	});

	it("pins a frozen, non-enumerable slot with an accessor size that no in-realm write can remove, replace or shrink", () => {
		const out = inFreshRealm(`
const a = await load("a");
a.rememberResolvedReferenceValue("marker-pin-12965-aaaa");
const slot = globalThis[KEY];
const descriptor = Object.getOwnPropertyDescriptor(globalThis, KEY);
const attempts = {};
const attempt = (name, write) => {
	try {
		write();
		attempts[name] = "allowed";
	} catch (error) {
		attempts[name] = error.constructor.name;
	}
};
attempt("assign", () => { globalThis[KEY] = {}; });
attempt("delete", () => { delete globalThis[KEY]; });
attempt("defineProperty", () => Object.defineProperty(globalThis, KEY, { value: {} }));
attempt("replaceAdd", () => { slot.add = () => {}; });
attempt("addClear", () => { slot.clear = () => {}; });
attempt("setPrototypeOf", () => Object.setPrototypeOf(slot, null));
const reflectSet = Reflect.set(globalThis, KEY, {});
const sizeBefore = slot.size;
const listed = slot.values();
listed.length = 0;
return {
	writable: descriptor.writable,
	configurable: descriptor.configurable,
	enumerable: descriptor.enumerable,
	frozen: Object.isFrozen(slot),
	version: slot.version,
	members: Object.keys(slot).sort(),
	sizeIsAccessor: typeof Object.getOwnPropertyDescriptor(slot, "size").get === "function",
	attempts,
	reflectSet,
	sameSlot: globalThis[KEY] === slot,
	sizeKept: slot.size === sizeBefore && sizeBefore > 0,
	stillRedacts: a.redactResolvedReferenceValues("x marker-pin-12965-aaaa y"),
};`);

		expect(out).toEqual({
			writable: false,
			configurable: false,
			enumerable: false,
			frozen: true,
			version: 1,
			members: ["add", "size", "values", "version"],
			sizeIsAccessor: true,
			attempts: {
				assign: "TypeError",
				delete: "TypeError",
				defineProperty: "TypeError",
				replaceAdd: "TypeError",
				addClear: "TypeError",
				setPrototypeOf: "TypeError",
			},
			reflectSet: false,
			sameSlot: true,
			sizeKept: true,
			stillRedacts: "x <redacted> y",
		});
	});

	it("accepts only strings of 4 to 65,536 characters", () => {
		const out = inFreshRealm(`
await load("a");
const slot = globalThis[KEY];
const before = slot.size;
slot.add(12345678);
slot.add({ toString: () => "object-12965-value" });
slot.add("abc");
slot.add("x".repeat(65_537));
const rejected = slot.size - before;
slot.add("abcd");
slot.add("y".repeat(65_536));
return { rejected, accepted: slot.size - before - rejected };`);

		expect(out).toEqual({ rejected: 0, accepted: 2 });
	});

	describe("refuses to load next to a slot it did not pin (fail closed)", () => {
		const shape = `{ version: 1, add() {}, get size() { return 0; }, values() { return []; } }`;
		const pinned = (value: string) =>
			`Object.defineProperty(globalThis, KEY, { value: ${value}, writable: false, configurable: false, enumerable: false });`;
		const cases: readonly [string, string][] = [
			["an unpinned, frozen slot of the right shape", `globalThis[KEY] = Object.freeze(${shape});`],
			["a pinned slot that is not frozen", pinned(shape)],
			["a pinned, frozen slot of another version", pinned(`Object.freeze({ ...${shape}, version: 2 })`)],
			[
				"a pinned, frozen slot whose size is not a number",
				pinned(`Object.freeze({ version: 1, add() {}, size: "0", values() { return []; } })`),
			],
			["a pinned, frozen slot without values()", pinned(`Object.freeze({ version: 1, add() {}, size: 0 })`)],
			[
				"an accessor slot",
				`Object.defineProperty(globalThis, KEY, { get: () => Object.freeze(${shape}), configurable: false });`,
			],
		];
		for (const [label, plant] of cases) {
			it(label, () => {
				const out = inFreshRealm(`${plant}\n${importOutcome}`);

				expect(out).toMatchObject({ imported: false, name: "ConfigReferenceRedactionSlotError", code: SLOT_ERROR });
				expect(out.message).toContain(SLOT_KEY);
			});
		}
	});

	it("adopts a pinned, frozen v1 slot that carries members it does not know", () => {
		const out = inFreshRealm(`
const backing = new Set();
Object.defineProperty(globalThis, KEY, {
	value: Object.freeze({
		version: 1,
		add(value) { backing.add(value); },
		get size() { return backing.size; },
		values() { return [...backing]; },
		addedByALaterContract() {},
	}),
	writable: false,
	configurable: false,
	enumerable: false,
});
const a = await load("a");
a.rememberResolvedReferenceValue("marker-adopt-12965-k8f2");
return { recorded: backing.has("marker-adopt-12965-k8f2"), redacted: a.redactResolvedReferenceValues("x marker-adopt-12965-k8f2 y") };`);

		expect(out).toEqual({ recorded: true, redacted: "x <redacted> y" });
	});
});
