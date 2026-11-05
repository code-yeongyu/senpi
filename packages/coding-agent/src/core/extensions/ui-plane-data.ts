/**
 * Whether a value crosses the plane unchanged: plain JSON data only. A component factory or a callback (a `setWidget`
 * factory, an action), a cycle, a non-finite number, a nested `undefined` or a class instance (`Date`, `Map`) would
 * arrive different from what fused presents, so it stays on the hand's own UI instead.
 */
export function survivesPlane(value: unknown, path: Set<object> = new Set()): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || path.has(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
	path.add(value);
	const plain = (Array.isArray(value) ? value : Object.values(value)).every((item) => survivesPlane(item, path));
	path.delete(value);
	return plain;
}
