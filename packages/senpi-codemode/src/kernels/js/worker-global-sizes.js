import { types } from "node:util";

const SAMPLED_ELEMENTS = 1_000;
const NODE_BUDGET = 200_000;
const MAX_DEPTH = 64;
const POINTER_BYTES = 8;
const OBJECT_BYTES = 16;
const FUNCTION_BYTES = 64;
const INTERNAL_GLOBAL_PREFIX = "__senpi";
const MIN_REPORTED_BYTES = 1024 * 1024;

function intrinsicGetter(prototype, name) {
	return Object.getOwnPropertyDescriptor(prototype, name)?.get;
}

// Built-in getters captured at load: a user subclass that overrides `byteLength` or `size` is never called.
const TYPED_ARRAY_BYTE_LENGTH = intrinsicGetter(Object.getPrototypeOf(Uint8Array.prototype), "byteLength");
const DATA_VIEW_BYTE_LENGTH = intrinsicGetter(DataView.prototype, "byteLength");
const ARRAY_BUFFER_BYTE_LENGTH = intrinsicGetter(ArrayBuffer.prototype, "byteLength");
const SHARED_ARRAY_BUFFER_BYTE_LENGTH =
	typeof SharedArrayBuffer === "function" ? intrinsicGetter(SharedArrayBuffer.prototype, "byteLength") : undefined;
const MAP_SIZE = intrinsicGetter(Map.prototype, "size");
const SET_SIZE = intrinsicGetter(Set.prototype, "size");
const BLOB_SIZE = typeof Blob === "function" ? intrinsicGetter(Blob.prototype, "size") : undefined;
// Iteration captured at load too: a user who replaces Map.prototype.entries or an iterator's next() is never called.
const MAP_ENTRIES = Map.prototype.entries;
const SET_VALUES = Set.prototype.values;
const MAP_ITERATOR_NEXT = Object.getPrototypeOf(new Map().entries()).next;
const SET_ITERATOR_NEXT = Object.getPrototypeOf(new Set().values()).next;

function read(getter, value) {
	return Reflect.apply(getter, value, []);
}

const GET_PROTOTYPE_OF = Object.getPrototypeOf;
const BLOB_PROTOTYPE = typeof Blob === "function" ? Blob.prototype : undefined;

function inheritsFromBlob(value) {
	for (let prototype = GET_PROTOTYPE_OF(value); prototype !== null; prototype = GET_PROTOTYPE_OF(prototype)) {
		// A Proxy in the chain would run its getPrototypeOf trap on the next step.
		if (types.isProxy(prototype)) return false;
		if (prototype === BLOB_PROTOTYPE) return true;
	}
	return false;
}

// The Blob brand: a cheap prototype-chain pre-check (no user hook; proxies never reach here) so ordinary
// objects skip the try, then the size getter as the proof, which throws on a forged look-alike.
// instanceof would call a user-redefinable Symbol.hasInstance.
function isBlob(value) {
	if (BLOB_SIZE === undefined || !inheritsFromBlob(value)) return false;
	try {
		read(BLOB_SIZE, value);
		return true;
	} catch {
		return false;
	}
}

export function captureGlobalBaseline() {
	return new Set(Object.getOwnPropertyNames(globalThis));
}

/**
 * Estimated retained size of each user global, largest first. Collections are sized from their length and
 * a sample of up to 1,000 evenly spaced elements, so a huge array is not under-reported; a shared visited
 * set counts shared objects once, and one node budget bounds the whole walk. A sampled or cut-short
 * estimate is marked `approximate`. Accessors and proxies are never invoked.
 */
export function largestGlobals(baseline, limit) {
	const sizer = createSizer();
	const sized = [];
	for (const name of Object.getOwnPropertyNames(globalThis)) {
		if (baseline.has(name) || name.startsWith(INTERNAL_GLOBAL_PREFIX)) continue;
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
		if (descriptor === undefined || !("value" in descriptor)) continue;
		const measured = sizer.measure(descriptor.value);
		if (measured === undefined) continue;
		const { bytes, approximate } = measured;
		sized.push({ name, bytes: Math.round(bytes), ...(approximate ? { approximate: true } : {}) });
	}
	return sized
		.filter((global) => global.bytes >= MIN_REPORTED_BYTES)
		.sort((left, right) => right.bytes - left.bytes)
		.slice(0, limit);
}

function createSizer() {
	const seen = new WeakSet();
	let nodes = 0;
	let approximate = false;

	function sampled(length, at, depth) {
		if (length <= SAMPLED_ELEMENTS) {
			let total = 0;
			for (let index = 0; index < length; index += 1) total += size(at(index), depth);
			return total;
		}
		approximate = true;
		const step = length / SAMPLED_ELEMENTS;
		let total = 0;
		for (let sample = 0; sample < SAMPLED_ELEMENTS; sample += 1) total += size(at(Math.floor(sample * step)), depth);
		return (total / SAMPLED_ELEMENTS) * length;
	}

	function entriesOf(iterator, next, count, depth, sizeOf) {
		const taken = [];
		while (taken.length < SAMPLED_ELEMENTS) {
			const step = Reflect.apply(next, iterator, []);
			if (step.done) break;
			taken.push(step.value);
		}
		if (taken.length < count) approximate = true;
		let total = 0;
		for (const entry of taken) total += sizeOf(entry, depth);
		return total * (count / Math.max(1, taken.length));
	}

	// An own data element, never a getter: an accessor is left unsized and makes the estimate approximate.
	function elementOf(array, index) {
		const descriptor = Object.getOwnPropertyDescriptor(array, index);
		if (descriptor === undefined) return undefined;
		if ("value" in descriptor) return descriptor.value;
		approximate = true;
		return undefined;
	}

	function objectSize(value, depth) {
		if (types.isProxy(value)) return OBJECT_BYTES;
		if (types.isTypedArray(value)) return read(TYPED_ARRAY_BYTE_LENGTH, value);
		if (types.isDataView(value)) return read(DATA_VIEW_BYTE_LENGTH, value);
		if (types.isArrayBuffer(value)) return read(ARRAY_BUFFER_BYTE_LENGTH, value);
		if (types.isSharedArrayBuffer(value) && SHARED_ARRAY_BUFFER_BYTE_LENGTH) return read(SHARED_ARRAY_BUFFER_BYTE_LENGTH, value);
		if (isBlob(value)) return read(BLOB_SIZE, value);
		if (Array.isArray(value)) {
			const length = value.length;
			return OBJECT_BYTES + length * POINTER_BYTES + sampled(length, (index) => elementOf(value, index), depth);
		}
		if (types.isMap(value)) {
			const count = read(MAP_SIZE, value);
			const entries = Reflect.apply(MAP_ENTRIES, value, []);
			return OBJECT_BYTES + count * 2 * POINTER_BYTES + entriesOf(entries, MAP_ITERATOR_NEXT, count, depth, ([key, item], at) => size(key, at) + size(item, at));
		}
		if (types.isSet(value)) {
			const count = read(SET_SIZE, value);
			return OBJECT_BYTES + count * POINTER_BYTES + entriesOf(Reflect.apply(SET_VALUES, value, []), SET_ITERATOR_NEXT, count, depth, size);
		}
		const keys = Object.keys(value);
		const propertyValue = (index) => {
			const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
			if (descriptor === undefined) return undefined;
			if ("value" in descriptor) return descriptor.value;
			approximate = true;
			return undefined;
		};
		return OBJECT_BYTES + keys.length * POINTER_BYTES + sampled(keys.length, propertyValue, depth);
	}

	// Bytes a value owns beyond the pointer-sized slot its container already charged for it.
	function size(value, depth) {
		switch (typeof value) {
			case "string":
				return OBJECT_BYTES + value.length * 2;
			case "function":
				return FUNCTION_BYTES;
			case "object":
				break;
			default:
				return 0;
		}
		if (value === null || seen.has(value)) return 0;
		if (depth >= MAX_DEPTH || nodes >= NODE_BUDGET) {
			approximate = true;
			return 0;
		}
		seen.add(value);
		nodes += 1;
		return objectSize(value, depth + 1);
	}

	return {
		measure(value) {
			approximate = false;
			try {
				return { bytes: POINTER_BYTES + size(value, 0), approximate };
			} catch (error) {
				// A forged built-in look-alike (a Blob-prototype object without its slot) throws from the intrinsic getter; it is left unsized.
				if (error instanceof Error) return undefined;
				throw error;
			}
		},
	};
}
