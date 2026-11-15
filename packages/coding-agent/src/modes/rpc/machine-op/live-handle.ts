/**
 * One `exec_command` terminal as the relay host's wire sees it (senpi#6752), over a `TerminalRuntimeSession` the engine's
 * `TerminalManager` owns. The raw PTY bytes are counted and the last `RETAINED_OUTPUT_BYTES` kept, so `lastSeq` and
 * `totalBytes` stay byte offsets. Lifecycle as the relay host runs it: running; waiting_input once the program has been
 * quiet for OUTPUT_SETTLE_MS while the terminal's foreground group is the shell's own (unknown counts as yes); running
 * again on the next output; then exited, or killed after a kill request. Each settled quiet period is also announced.
 */
import { readFile } from "node:fs/promises";
import type { TerminalRuntimeSession } from "../../../core/extensions/builtin/terminal/runtime-session.ts";

export const OUTPUT_SETTLE_MS = 800;
export const RETAINED_OUTPUT_BYTES = 1024 * 1024;

export type MachineLifecycle = "starting" | "running" | "waiting_input" | "exited" | "killed" | "lost";
export const MACHINE_LIFECYCLES: readonly MachineLifecycle[] = [
	"starting",
	"running",
	"waiting_input",
	"exited",
	"killed",
	"lost",
];
export const ENDED: readonly MachineLifecycle[] = ["exited", "killed", "lost"];
export const ended = (state: MachineLifecycle): boolean => ENDED.includes(state);

export type HandleExit = Readonly<{ exitCode: number | null; signal: string | null }>;
export type HandleEvent =
	| Readonly<{ kind: "output"; seq: number; bytes: Uint8Array }>
	| Readonly<{ kind: "state"; state: MachineLifecycle }>
	| Readonly<{ kind: "idle"; foreground: boolean | null }>;
export type After = (ms: number, fn: () => void) => () => void;

const PASTE_ON = "\x1b[?2004h";
const PASTE_OFF = "\x1b[?2004l";

/** Linux: whether the terminal's foreground process group is the leader's own (field 8 of /proc/<pid>/stat). */
async function foregroundOf(pid: number | undefined): Promise<boolean | null> {
	if (pid === undefined || process.platform !== "linux") return null;
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return Number(fields[8 - 3]) === pid;
	} catch {
		return null;
	}
}

export interface LiveHandleInit {
	readonly id: string;
	readonly sender: string;
	readonly runtime: TerminalRuntimeSession;
	readonly after: After;
}

export function createLiveHandle(init: LiveHandleInit) {
	const session = init.runtime.session;
	const pid = session.pid;
	const listeners = new Set<(e: HandleEvent) => void>();
	const done = Promise.withResolvers<void>();
	// Output that arrived while the manager registered the session: the session's raw tail and byte count.
	const early = new Uint8Array(session.rawTail);
	const chunks: Uint8Array[] = early.byteLength === 0 ? [] : [early];
	let retained = early.byteLength;
	let produced = session.rawOutputBytes;
	let state: MachineLifecycle = "running";
	let exit: HandleExit | null = null;
	let killed = false;
	let quiet = false;
	let paste = false;
	let pasteCarry = "";
	let cancelSettle: () => void = () => {};

	const emit = (e: HandleEvent): void => {
		for (const listener of [...listeners]) listener(e);
	};
	const setState = (next: MachineLifecycle): void => {
		if (next === state) return;
		state = next;
		emit({ kind: "state", state: next });
	};
	const armSettle = (): void => {
		cancelSettle();
		if (exit !== null) return;
		const at = produced;
		cancelSettle = init.after(OUTPUT_SETTLE_MS, () => {
			void foregroundOf(pid).then((foreground) => {
				if (exit !== null || produced !== at) return;
				quiet = true;
				if (foreground !== false) setState("waiting_input");
				emit({ kind: "idle", foreground });
			});
		});
	};
	const keep = (bytes: Uint8Array): void => {
		chunks.push(bytes);
		retained += bytes.byteLength;
		while (retained > RETAINED_OUTPUT_BYTES) {
			const first = chunks[0] ?? new Uint8Array(0);
			const cut = retained - RETAINED_OUTPUT_BYTES;
			if (first.byteLength <= cut) chunks.shift();
			else chunks[0] = first.subarray(cut);
			retained -= Math.min(cut, first.byteLength);
		}
	};
	// The program's bracketed-paste mode, from the last mode switch in its output (a switch may span two chunks).
	const trackPaste = (bytes: Uint8Array): void => {
		const seen = pasteCarry + Buffer.from(bytes).toString("latin1");
		const on = seen.lastIndexOf(PASTE_ON);
		const off = seen.lastIndexOf(PASTE_OFF);
		if (on !== off) paste = on > off;
		pasteCarry = seen.slice(-(PASTE_ON.length - 1));
	};

	const unsubscribeData = session.onData((chunk) => {
		const bytes = new Uint8Array(chunk);
		produced += bytes.byteLength;
		keep(bytes);
		trackPaste(bytes);
		quiet = false;
		if (state === "waiting_input") setState("running");
		emit({ kind: "output", seq: produced, bytes });
		armSettle();
	});
	session.onExit(() => {
		const result = session.exitResult;
		exit = { exitCode: result?.exitCode ?? null, signal: result?.signal ?? null };
		cancelSettle();
		unsubscribeData();
		setState(killed ? "killed" : "exited");
		done.resolve();
	});
	armSettle();

	return {
		id: init.id,
		pid,
		sender: init.sender,
		startedMs: init.runtime.startedAtMs,
		state: (): MachineLifecycle => state,
		exit: (): HandleExit | null => exit,
		produced: (): number => produced,
		retainedFrom: (): number => produced - retained,
		/** The retained bytes from `seq` (or from the oldest retained byte, when `seq` is older) to the end. */
		since: (seq: number): Uint8Array => {
			const from = produced - retained;
			const all = Buffer.concat(chunks, retained);
			return new Uint8Array(all.subarray(Math.max(0, Math.min(seq, produced) - from)));
		},
		quiet: (): boolean => quiet,
		bracketedPaste: (): boolean => paste,
		on: (listener: (e: HandleEvent) => void): (() => void) => {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
		write: (bytes: Uint8Array): void => void session.write(bytes),
		markKilled: (): void => {
			killed = true;
		},
		ended: done.promise,
		dispose: (): void => {
			cancelSettle();
			unsubscribeData();
			listeners.clear();
		},
	};
}
export type LiveHandle = ReturnType<typeof createLiveHandle>;
