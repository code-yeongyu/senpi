/**
 * T-C (omo#12965): the realm-registry contract. Each case runs in a FRESH realm (a child Node process), because a pinned
 * slot cannot be removed: nothing in the test realm could reset it, and a planted slot must exist before the first copy
 * evaluates. Two byte-identical copies of the helper stand for two engine copies that each inlined it.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SOURCE = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const KEY = "@code-yeongyu/senpi/x12965-test/v1";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inFreshRealm(body: string): Record<string, unknown> {
	const root = mkdtempSync(join(tmpdir(), "senpi-realm-registry-"));
	roots.push(root);
	for (const copy of ["a", "b"]) {
		mkdirSync(join(root, copy));
		copyFileSync(SOURCE, join(root, copy, "realm-registry.ts"));
	}
	writeFileSync(
		join(root, "main.mjs"),
		[
			`const KEY_NAME = ${JSON.stringify(KEY)};`,
			"const KEY = Symbol.for(KEY_NAME);",
			'const load = (copy) => import("./" + copy + "/realm-registry.ts");',
			"const isV1 = (value) => typeof value?.read === 'function';",
			"const v1 = () => { let n = 0; return { read: () => n, bump: () => ++n }; };",
			"const outcome = (fn) => { try { fn(); return { threw: false }; } catch (error) { return { threw: true, name: error.name, code: error.code, key: error.key, message: error.message }; } };",
			`const out = await (async () => {\n${body}\n})();`,
			"process.stdout.write(JSON.stringify(out));",
		].join("\n"),
	);
	const run = spawnSync(process.execPath, [join(root, "main.mjs")], { encoding: "utf8", timeout: 20_000 });
	if (run.status !== 0) throw new Error(`fresh realm exited ${String(run.status)}: ${run.stderr}`);
	return JSON.parse(run.stdout) as Record<string, unknown>;
}

describe("realm registry contract (omo#12965, T-C)", () => {
	it("pins one frozen, non-enumerable instance that two copies of the helper share and no write path replaces", () => {
		const out = inFreshRealm(`
const a = await load("a");
const b = await load("b");
const first = a.realmRegistry(KEY_NAME, v1, isV1);
const second = b.realmRegistry(KEY_NAME, () => { throw new Error("must adopt, not create"); }, isV1);
first.bump();
const slot = Object.getOwnPropertyDescriptor(globalThis, KEY);
const deleted = Reflect.deleteProperty(globalThis, KEY);
const assigned = Reflect.set(globalThis, KEY, {});
const redefined = outcome(() => Object.defineProperty(globalThis, KEY, { value: {} }));
const memberWrite = Reflect.set(first, "read", () => 99);
return {
	same: first === second, sharedState: second.read(), frozen: Object.isFrozen(first),
	writable: slot.writable, configurable: slot.configurable, enumerable: slot.enumerable,
	inKeys: Object.keys(globalThis).length !== Object.keys(Object.assign({}, globalThis)).length,
	forIn: (() => { for (const k in globalThis) if (k === KEY_NAME) return true; return false; })(),
	deleted, assigned, redefinedThrew: redefined.threw, memberWrite, stillSame: globalThis[KEY] === first,
};`);
		expect(out).toEqual({
			same: true,
			sharedState: 1,
			frozen: true,
			writable: false,
			configurable: false,
			enumerable: false,
			inKeys: false,
			forIn: false,
			deleted: false,
			assigned: false,
			redefinedThrew: true,
			memberWrite: false,
			stillSame: true,
		});
	});

	it.each([
		[
			"a writable slot",
			"Object.defineProperty(globalThis, KEY, { value: Object.freeze(v1()), writable: true, configurable: false });",
		],
		[
			"a configurable slot",
			"Object.defineProperty(globalThis, KEY, { value: Object.freeze(v1()), writable: false, configurable: true });",
		],
		[
			"an unfrozen value",
			"Object.defineProperty(globalThis, KEY, { value: v1(), writable: false, configurable: false });",
		],
		[
			"an accessor",
			"Object.defineProperty(globalThis, KEY, { get: () => Object.freeze(v1()), configurable: false });",
		],
		[
			"a value without the v1 members",
			"Object.defineProperty(globalThis, KEY, { value: Object.freeze({ secret: 'planted-value-x12965' }), writable: false, configurable: false });",
		],
		[
			"a primitive",
			"Object.defineProperty(globalThis, KEY, { value: 'planted-value-x12965', writable: false, configurable: false });",
		],
	])("refuses %s with a typed error naming the key and never the value", (_label, plant) => {
		const out = inFreshRealm(`
${plant}
const a = await load("a");
return { create: outcome(() => a.realmRegistry(KEY_NAME, v1, isV1)), lookup: outcome(() => a.realmRegistryLookup(KEY_NAME, isV1)) };`);
		for (const result of [out.create, out.lookup]) {
			expect(result).toMatchObject({
				threw: true,
				name: "RealmRegistryError",
				code: "SENPI_REALM_REGISTRY_FOREIGN",
				key: KEY,
			});
			expect(JSON.stringify(result)).not.toContain("planted-value-x12965");
		}
	});

	it("lets a copy that knows a newer member adopt a v1-only instance and work through v1", () => {
		const out = inFreshRealm(`
const a = await load("a");
const b = await load("b");
const older = a.realmRegistry(KEY_NAME, v1, isV1);
const newer = b.realmRegistry(KEY_NAME, () => ({ ...v1(), reset() {} }), isV1);
older.bump();
return { same: older === newer, hasNewerMember: typeof newer.reset === "function", read: newer.read() };`);
		expect(out).toEqual({ same: true, hasNewerMember: false, read: 1 });
	});

	it("looks up without creating, and adopts what another copy created later", () => {
		const out = inFreshRealm(`
const a = await load("a");
const b = await load("b");
const before = b.realmRegistryLookup(KEY_NAME, isV1);
const created = a.realmRegistry(KEY_NAME, v1, isV1);
return { before: before === undefined, slotBefore: false, after: b.realmRegistryLookup(KEY_NAME, isV1) === created };`);
		expect(out).toEqual({ before: true, slotBefore: false, after: true });
	});

	it("keeps a caller's own refusal for a planted slot (the redaction registry's error and code)", () => {
		const out = inFreshRealm(`
Object.defineProperty(globalThis, KEY, { value: {}, writable: true, configurable: true });
const a = await load("a");
class Own extends Error { constructor(cause) { super("own", cause === undefined ? undefined : { cause }); this.code = "OWN_CODE"; } }
return outcome(() => a.realmRegistry(KEY_NAME, v1, isV1, (cause) => new Own(cause)));`);
		expect(out).toMatchObject({ threw: true, code: "OWN_CODE" });
	});
});
