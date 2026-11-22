/**
 * Lazy boundary for `@earendil-works/pi-pty` (and `@xterm/headless`).
 *
 * pi-pty's screen model evaluates `@xterm/headless` at module load. senpi's CLI imports this package on its startup
 * graph (the built-in tools), and that graph must not reach pi-pty or xterm (coding-agent's 1781-lazy-pty
 * regression test), so the in-process holder awaits {@link loadPty} on its first spawn instead of importing it.
 *
 * Same pattern as coding-agent's `core/extensions/builtin/terminal/pty.lazy.ts`.
 */

type PtyModule = typeof import("@earendil-works/pi-pty");

let loaded: Promise<PtyModule> | undefined;

export function loadPty(): Promise<PtyModule> {
	loaded ??= import("@earendil-works/pi-pty");
	return loaded;
}
