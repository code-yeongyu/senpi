/**
 * Lazy boundary for `@earendil-works/pi-pty` (and `@xterm/headless`).
 *
 * pi-pty's screen model imports `@xterm/headless` at module evaluation, which
 * spends hundreds of milliseconds in `RegExp.prototype.test` on every CLI boot
 * even when no terminal session is created. This module owns the one deferred
 * import; session construction awaits {@link loadPty} first.
 *
 * Follows the repository's documented lazy-boundary pattern
 * (`packages/ai/src/api/*.lazy.ts`).
 */

type PtyModule = typeof import("@earendil-works/pi-pty");

let loaded: PtyModule | undefined;

export async function loadPty(): Promise<PtyModule> {
	loaded ??= await import("@earendil-works/pi-pty");
	return loaded;
}

/** The loaded module, or `undefined` until something has awaited {@link loadPty}. */
export function loadedPty(): PtyModule | undefined {
	return loaded;
}
