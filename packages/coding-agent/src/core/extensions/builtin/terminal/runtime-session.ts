import type {
	TerminalScreen,
	TerminalScreenSnapshot,
	TerminalSession,
	TerminalSessionExit,
	TerminalSessionOptions,
} from "@earendil-works/pi-pty";
import { SecretOutputRedactor } from "../../../tools/secret-output-redactor.ts";
import { type ChildProcessIdentity, processBootAtMs } from "./process-identity.ts";
import { loadPty } from "./pty.lazy.ts";
import { DEFAULT_SCROLLBACK, MAX_SESSION_OUTPUT_CHARS } from "./shared.ts";

const pty = await loadPty();

export interface TerminalRuntimeOptions extends TerminalSessionOptions {
	readonly scrollback?: number;
	readonly redactSecretsInOutput?: boolean;
}

export interface DeltaRead {
	readonly text: string;
	readonly droppedChars: number;
}

const RELEASED_SCREEN: TerminalScreenSnapshot = {
	cols: 0,
	rows: 0,
	visibleGrid: [],
	scrollback: [],
	cursor: { x: 0, y: 0 },
};

/**
 * A live terminal session: a pi-pty {@link TerminalSession} plus an xterm screen model
 * and a bounded decoded-output buffer with a per-consumer read cursor. Reads are pure
 * non-blocking peeks; watchers subscribe through `onOutput` (the monitor path).
 *
 * Once the process exits, the screen model is replaced by its final visible screen: an exited session
 * stays listed until the registry needs its slot, and a live xterm with its scrollback and replay
 * history costs tens of MB that nothing reads after exit (senpi#3171).
 */
export class TerminalRuntimeSession {
	readonly session: TerminalSession;
	readonly command: string;
	readonly startedAtMs: number;
	private readonly argv: readonly string[];
	private screen: TerminalScreen | null;
	private finalScreen: TerminalScreenSnapshot | null = null;
	private readonly screenRelease: Promise<void>;
	private readonly decoder = new TextDecoder("utf-8", { fatal: false });
	private readonly redactor: SecretOutputRedactor | undefined;
	private redactionIdleTimer: ReturnType<typeof setTimeout> | undefined;
	private buffer = "";
	private droppedChars = 0;
	private consumed = 0;
	private readonly outputListeners = new Set<(chunk: string) => void>();
	private readonly disposeListeners = new Set<() => void>();
	private unsubscribeData: (() => void) | null = null;

	constructor(command: string, options: TerminalRuntimeOptions) {
		this.redactor = options.redactSecretsInOutput === true ? new SecretOutputRedactor() : undefined;
		this.command = command;
		this.argv = [options.command ?? command, ...(options.args ?? [])];
		this.screen = new pty.TerminalScreen({
			cols: options.cols,
			rows: options.rows,
			scrollback: options.scrollback ?? DEFAULT_SCROLLBACK,
		});
		this.session = new pty.TerminalSession(options);
		this.unsubscribeData = this.session.onData((chunk) => {
			const text = this.decoder.decode(chunk, { stream: true });
			this.ingest(this.redactor ? this.redactor.push(text) : text);
			const redactor = this.redactor;
			if (redactor) {
				clearTimeout(this.redactionIdleTimer);
				this.redactionIdleTimer = setTimeout(() => {
					this.redactionIdleTimer = undefined;
					this.ingest(redactor.flushIdle());
				}, 50);
				this.redactionIdleTimer.unref?.();
			}
		});
		this.screenRelease = new Promise((resolve) => {
			this.session.onExit(() => {
				clearTimeout(this.redactionIdleTimer);
				this.redactionIdleTimer = undefined;
				if (this.redactor) this.ingest(this.redactor.push(this.decoder.decode()) + this.redactor.finish());
				// Best-effort like every screen write (#837): a failed release leaves an empty final screen, never an unhandled rejection.
				void this.releaseScreen()
					.catch(() => {})
					.finally(resolve);
			});
		});
		this.session.start();
		this.startedAtMs = Date.now();
	}

	/** Resolves once an exited session has kept its final visible screen and dropped the screen model. */
	screenReleased(): Promise<void> {
		return this.screenRelease;
	}

	private async releaseScreen(): Promise<void> {
		const screen = this.screen;
		if (!screen) return;
		await screen.flush().catch(() => {});
		if (this.screen !== screen) return;
		this.screen = null;
		try {
			this.finalScreen = { ...screen.snapshot(), scrollback: [] };
		} finally {
			screen.dispose();
		}
	}

	get backend(): string | null {
		return this.session.backend;
	}

	/** The spawned child as a later process can recognise it; undefined when the backend exposes no pid. */
	identity(): ChildProcessIdentity | undefined {
		const pid = this.session.pid;
		if (pid === undefined) return undefined;
		const processGroupId = this.session.processGroupId;
		return {
			pid,
			...(processGroupId === undefined ? {} : { processGroupId }),
			startedAtMs: this.startedAtMs,
			bootAtMs: processBootAtMs(),
			argv: this.argv,
		};
	}

	get exited(): boolean {
		return this.session.exited;
	}

	get exitResult(): TerminalSessionExit | null {
		return this.session.exitResult;
	}

	/** Total decoded chars produced so far (including any dropped from the front). */
	get totalChars(): number {
		return this.droppedChars + this.buffer.length;
	}

	private ingest(text: string): void {
		if (text.length === 0) return;
		if (this.screen) this.ownScreenWrite(this.screen.feed(text));
		this.buffer += text;
		if (this.buffer.length > MAX_SESSION_OUTPUT_CHARS) {
			const overflow = this.buffer.length - MAX_SESSION_OUTPUT_CHARS;
			this.buffer = this.buffer.slice(overflow);
			this.droppedChars += overflow;
		}
		for (const listener of this.outputListeners) {
			try {
				listener(text);
			} catch {
				// Output observers must not interfere with the session's ingest path.
			}
		}
	}

	/** Subscribe to decoded output without affecting the read cursor. */
	onOutput(listener: (chunk: string) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	/** Called once when the wrapper is disposed (registry eviction or teardown). */
	onDispose(listener: () => void): () => void {
		this.disposeListeners.add(listener);
		return () => this.disposeListeners.delete(listener);
	}

	/** Return output produced since the last read and advance the read cursor. */
	readDelta(): DeltaRead {
		const start = Math.max(this.consumed, this.droppedChars);
		const dropped = Math.max(0, this.droppedChars - this.consumed);
		const text = this.buffer.slice(start - this.droppedChars);
		this.consumed = this.totalChars;
		return { text, droppedChars: dropped };
	}

	/** Full retained decoded output (`view:"log"`), without advancing the cursor. */
	fullOutput(): string {
		return this.buffer;
	}

	snapshot(): TerminalScreenSnapshot {
		if (this.screen) return this.screen.snapshot();
		return this.finalScreen ?? RELEASED_SCREEN;
	}

	resizeScreen(cols: number, rows: number): void {
		if (this.screen) this.ownScreenWrite(this.screen.resize(cols, rows));
	}

	/**
	 * The screen is a best-effort projection; a rejected feed/resize must never
	 * become an unhandled rejection that kills the host process (#837), and
	 * `buffer` remains the source of truth for reads. The screen hands every
	 * caller coalesced into one queued operation the same memoized promise, so
	 * attach the rejection handler once per distinct promise - re-attaching per
	 * PTY chunk would grow promise reactions without bound while a replay is
	 * stalled behind a slow parser.
	 */
	private lastScreenWrite: Promise<void> | null = null;

	private ownScreenWrite(written: Promise<void>): void {
		if (written === this.lastScreenWrite) return;
		this.lastScreenWrite = written;
		written.catch(() => {});
	}

	dispose(): void {
		clearTimeout(this.redactionIdleTimer);
		this.redactionIdleTimer = undefined;
		this.unsubscribeData?.();
		this.unsubscribeData = null;
		this.outputListeners.clear();
		this.screen?.dispose();
		this.screen = null;
		const disposeListeners = [...this.disposeListeners];
		this.disposeListeners.clear();
		for (const listener of disposeListeners) listener();
	}
}
