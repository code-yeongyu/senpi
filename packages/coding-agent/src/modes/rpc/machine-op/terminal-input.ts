/**
 * The relay host's stdin path (its `input.ts`, ported): one input queue per handle so writes never interleave; `paste`
 * brackets the text when the program turned bracketed paste on; named keys go one at a time KEY_GAP_MS apart (a TUI
 * reading escape sequences needs the gap); with `expectActivityMs` the effect reports whether output followed.
 */
import type { After, LiveHandle } from "./live-handle.ts";

const KEY_GAP_MS = 30;

const NAMED: Readonly<Record<string, string>> = {
	enter: "\r",
	return: "\r",
	tab: "\t",
	escape: "\x1b",
	esc: "\x1b",
	backspace: "\x7f",
	space: " ",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	home: "\x1b[H",
	end: "\x1b[F",
	delete: "\x1b[3~",
	pageup: "\x1b[5~",
	pagedown: "\x1b[6~",
};
const encoder = new TextEncoder();

/** `ctrl+c`, `alt+x`, `enter`, a single character; undefined for a key this encoder does not know. */
export const encodeKey = (key: string): Uint8Array | undefined => {
	const k = key.toLowerCase();
	const ctrl = /^ctrl\+(.)$/.exec(k)?.[1];
	if (ctrl !== undefined) {
		const code = ctrl.charCodeAt(0);
		if (code >= 0x40 && code <= 0x7f) return Uint8Array.of(code & 0x1f);
		return undefined;
	}
	const alt = /^alt\+(.+)$/.exec(key)?.[1];
	if (alt !== undefined) {
		const rest = encodeKey(alt);
		return rest === undefined ? undefined : Uint8Array.of(0x1b, ...rest);
	}
	const named = NAMED[k];
	if (named !== undefined) return encoder.encode(named);
	return [...key].length === 1 ? encoder.encode(key) : undefined;
};

export type StdinInput = Readonly<{ data?: Uint8Array; keys?: readonly Uint8Array[]; paste?: boolean }>;
export type StdinEffect = Readonly<{ acceptedBytes: number; observed?: boolean }>;

const PASTE_START = encoder.encode("\x1b[200~");
const PASTE_END = encoder.encode("\x1b[201~");

export const createInputQueues = (after: After) => {
	const queues = new Map<string, Promise<unknown>>();
	const gap = (): Promise<void> => new Promise((resolve) => after(KEY_GAP_MS, resolve));
	const observe = (h: LiveHandle, ms: number): Readonly<{ seen: Promise<boolean>; stop: () => void }> => {
		const seen = Promise.withResolvers<boolean>();
		const cancel = after(ms, () => seen.resolve(false));
		const off = h.on((e) => {
			if (e.kind === "output") seen.resolve(true);
			if (e.kind === "state" && e.state !== "running" && e.state !== "waiting_input") seen.resolve(false);
		});
		return {
			seen: seen.promise,
			stop: () => {
				cancel();
				off();
			},
		};
	};
	const run = async (h: LiveHandle, input: StdinInput, expectMs?: number): Promise<StdinEffect> => {
		const watch = expectMs === undefined ? undefined : observe(h, expectMs);
		let accepted = 0;
		const put = (bytes: Uint8Array): void => {
			h.write(bytes);
			accepted += bytes.byteLength;
		};
		try {
			if (input.data !== undefined && input.data.byteLength > 0) {
				const bracket = input.paste === true && h.bracketedPaste();
				if (bracket) h.write(PASTE_START);
				put(input.data);
				if (bracket) h.write(PASTE_END);
			}
			for (const [i, key] of (input.keys ?? []).entries()) {
				if (i > 0) await gap();
				put(key);
			}
			return watch === undefined
				? { acceptedBytes: accepted }
				: { acceptedBytes: accepted, observed: await watch.seen };
		} finally {
			watch?.stop();
		}
	};
	return {
		write: (h: LiveHandle, input: StdinInput, expectMs?: number): Promise<StdinEffect> => {
			const prior = queues.get(h.id) ?? Promise.resolve();
			const next = prior.then(() => run(h, input, expectMs));
			const settled = next.catch(() => undefined);
			queues.set(h.id, settled);
			void settled.then(() => {
				if (queues.get(h.id) === settled) queues.delete(h.id);
			});
			return next;
		},
	};
};
