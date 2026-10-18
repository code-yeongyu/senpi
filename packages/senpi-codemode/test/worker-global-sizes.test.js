import { afterEach, describe, expect, it } from "vitest";
import { captureGlobalBaseline, largestGlobals } from "../src/kernels/js/worker-global-sizes.js";

const defined = [];

function defineGlobal(name, value) {
	Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true });
	defined.push(name);
}

afterEach(() => {
	for (const name of defined.splice(0)) Reflect.deleteProperty(globalThis, name);
});

describe("largest-globals sizing never runs user code", () => {
	it("Given a global array with an index accessor when the globals are sized then the getter never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const withAccessor = [];
		Object.defineProperty(withAccessor, 0, {
			get() {
				hits += 1;
				return 1;
			},
			enumerable: true,
		});
		defineGlobal("arrayWithAccessor", withAccessor);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given an array hole whose prototype has an index getter when the globals are sized then the prototype getter never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Holey extends Array {}
		Object.defineProperty(Holey.prototype, "1", {
			get() {
				hits += 1;
				return 1;
			},
		});
		const holey = new Holey();
		holey[0] = 1;
		holey[2] = 3;
		defineGlobal("holeyArray", holey);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given a typed array subclass that overrides byteLength when the globals are sized then its real byte length is reported without running the override", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Counted extends Uint8Array {
			get byteLength() {
				hits += 1;
				return 0;
			}
		}
		defineGlobal("countedBytes", new Counted(2 * 1024 * 1024));

		const sized = largestGlobals(baseline, 5);

		expect(hits).toBe(0);
		expect(sized.find((global) => global.name === "countedBytes")?.bytes).toBeGreaterThanOrEqual(2 * 1024 * 1024);
	});

	it("Given a Map subclass that overrides size when the globals are sized then the override never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		class Counted extends Map {
			get size() {
				hits += 1;
				return 0;
			}
		}
		const map = new Counted();
		for (let index = 0; index < 10; index += 1) map.set(index, "x".repeat(10));
		defineGlobal("countedMap", map);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});

	it("Given a fully walked array with one accessor element when the globals are sized then it is still reported, marked approximate", () => {
		const baseline = captureGlobalBaseline();
		const texts = Array.from({ length: 500 }, () => "x".repeat(4096));
		Object.defineProperty(texts, 0, { get: () => "x", enumerable: true });
		defineGlobal("mostlyTexts", texts);

		const sized = largestGlobals(baseline, 5);

		expect(sized.find((global) => global.name === "mostlyTexts")).toMatchObject({ approximate: true });
	});

	it("Given Set, DataView, ArrayBuffer and Blob subclasses that override their size getters when the globals are sized then no override runs and the real sizes are reported", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const MiB = 1024 * 1024;
		class CountedSet extends Set {
			get size() {
				hits += 1;
				return 0;
			}
		}
		class CountedView extends DataView {
			get byteLength() {
				hits += 1;
				return 0;
			}
		}
		class CountedBuffer extends ArrayBuffer {
			get byteLength() {
				hits += 1;
				return 0;
			}
		}
		class CountedBlob extends Blob {
			get size() {
				hits += 1;
				return 0;
			}
		}
		const set = new CountedSet();
		for (let index = 0; index < 600; index += 1) set.add("x".repeat(2048) + index);
		defineGlobal("countedSet", set);
		defineGlobal("countedView", new CountedView(new ArrayBuffer(2 * MiB)));
		defineGlobal("countedBuffer", new CountedBuffer(2 * MiB));
		defineGlobal("countedBlob", new CountedBlob([new Uint8Array(2 * MiB)]));

		const sized = largestGlobals(baseline, 10);
		const bytes = (name) => sized.find((global) => global.name === name)?.bytes ?? 0;

		expect(hits).toBe(0);
		for (const name of ["countedSet", "countedView", "countedBuffer", "countedBlob"]) expect(bytes(name)).toBeGreaterThanOrEqual(2 * MiB);
	});

	it("Given replaced Map and Set iteration methods and a redefined Blob instanceof hook when the globals are sized then none of them runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const count = () => {
			hits += 1;
		};
		const entries = Map.prototype.entries;
		const values = Set.prototype.values;
		const mapIteratorPrototype = Object.getPrototypeOf(new Map().entries());
		const mapNext = mapIteratorPrototype.next;
		const hasInstance = Object.getOwnPropertyDescriptor(Blob, Symbol.hasInstance);
		const map = new Map([[1, "x".repeat(2 * 1024 * 1024)]]);
		defineGlobal("plainMap", map);
		defineGlobal("plainSet", new Set(["x".repeat(2 * 1024 * 1024)]));
		defineGlobal("plainObject", { text: "x".repeat(2 * 1024 * 1024) });
		try {
			Map.prototype.entries = function () {
				count();
				return entries.call(this);
			};
			Set.prototype.values = function () {
				count();
				return values.call(this);
			};
			mapIteratorPrototype.next = function () {
				count();
				return mapNext.call(this);
			};
			Object.defineProperty(Blob, Symbol.hasInstance, { value: () => (count(), false), configurable: true });

			largestGlobals(baseline, 10);
		} finally {
			Map.prototype.entries = entries;
			Set.prototype.values = values;
			mapIteratorPrototype.next = mapNext;
			if (hasInstance) Object.defineProperty(Blob, Symbol.hasInstance, hasInstance);
			else Reflect.deleteProperty(Blob, Symbol.hasInstance);
		}

		expect(hits).toBe(0);
	});

	it("Given an object with an accessor property when the globals are sized then the accessor never runs and the estimate is approximate", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const holder = { text: "x".repeat(2 * 1024 * 1024) };
		Object.defineProperty(holder, "computed", {
			get() {
				hits += 1;
				return "y";
			},
			enumerable: true,
		});
		defineGlobal("withAccessor", holder);

		const sized = largestGlobals(baseline, 5);

		expect(hits).toBe(0);
		expect(sized.find((global) => global.name === "withAccessor")).toMatchObject({ approximate: true });
	});

	it("Given an object whose prototype is a Proxy when the globals are sized then the Proxy's getPrototypeOf trap never runs", () => {
		const baseline = captureGlobalBaseline();
		let hits = 0;
		const trapped = new Proxy(
			{},
			{
				getPrototypeOf(target) {
					hits += 1;
					return Reflect.getPrototypeOf(target);
				},
			},
		);
		const holder = Object.create(trapped);
		holder.text = "x".repeat(2 * 1024 * 1024);
		defineGlobal("proxyPrototype", holder);

		largestGlobals(baseline, 5);

		expect(hits).toBe(0);
	});
});
