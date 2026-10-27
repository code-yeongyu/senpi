import { expect } from "vitest";

const DELIVERY_STAMP = /"observedAt":"[^"]*"/g;

/**
 * Compare delivered RPC lines with reference bytes captured before the writer's enqueue.
 * The writer re-stamps observedAt on every delivered lifecycle copy (#3864), so that field
 * alone may differ; every other byte must match, and every delivered lifecycle line must
 * carry a stamp.
 */
export function expectSameBytesExceptDeliveryStamp(actual: readonly string[], expected: readonly string[]): void {
	const unstamped = (lines: readonly string[]) =>
		lines.map((line) => line.replace(DELIVERY_STAMP, '"observedAt":"<delivery>"'));
	expect(unstamped(actual)).toEqual(unstamped(expected));
	const lifecycle = actual.filter((line) => line.includes('"type":"session_lifecycle"'));
	expect(lifecycle.length, "the run delivers lifecycle lines").toBeGreaterThan(0);
	expect(lifecycle.every((line) => line.includes('"observedAt":"'))).toBe(true);
}
