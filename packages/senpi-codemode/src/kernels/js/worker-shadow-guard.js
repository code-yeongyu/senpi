// Snapshot is lazy on purpose: the first guard call is the first cell's
// transform, when prelude globals exist but no cell-created global does.
// A module-level snapshot would miss prelude globals; re-snapshotting later
// would wrongly protect cell-created names that must stay re-declarable.

let protectedGlobalNames;

function protectedGlobals() {
	if (protectedGlobalNames === undefined) {
		protectedGlobalNames = new Set(Object.getOwnPropertyNames(globalThis));
	}
	return protectedGlobalNames;
}

export function isKernelGlobal(name) {
	return protectedGlobals().has(name);
}
