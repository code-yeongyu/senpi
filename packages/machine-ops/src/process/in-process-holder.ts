import type { TerminalSession, TerminalScreen } from "@earendil-works/pi-pty";
import type { HeldExit, HeldTerminal, HolderLink, HolderSpawnRequest } from "./holder-link.ts";
import { loadPty } from "./pty.lazy.ts";

const SCREEN_SCROLLBACK = 1000;

class InProcessTerminal implements HeldTerminal {
	readonly id: string;
	readonly pid: number;
	private readonly session: TerminalSession;
	private readonly screenModel: TerminalScreen;
	private exit: HeldExit | undefined;
	private readonly exitWaiters = new Set<(exit: HeldExit) => void>();

	constructor(id: string, session: TerminalSession, screenModel: TerminalScreen) {
		const pid = session.pid;
		if (pid === undefined) throw new Error("terminal session started without a pid");
		this.id = id;
		this.pid = pid;
		this.session = session;
		this.screenModel = screenModel;
		session.onData((chunk) => {
			void this.screenModel.feed(chunk);
		});
		void session.waitExit().then(
			(exit) => this.settle({ exitCode: exit.exitCode, signal: exit.signal }),
			() => this.settle({ exitCode: null, signal: null }),
		);
	}

	private settle(exit: HeldExit): void {
		if (this.exit !== undefined) return;
		this.exit = exit;
		for (const waiter of this.exitWaiters) waiter(exit);
		this.exitWaiters.clear();
	}

	onData(listener: (chunk: Uint8Array) => void): () => void {
		return this.session.onData(listener);
	}

	onExit(listener: (exit: HeldExit) => void): () => void {
		const exit = this.exit;
		if (exit !== undefined) {
			queueMicrotask(() => listener(exit));
			return () => {};
		}
		this.exitWaiters.add(listener);
		return () => this.exitWaiters.delete(listener);
	}

	write(bytes: Uint8Array): void {
		this.session.write(bytes);
	}

	resize(cols: number, rows: number): void {
		this.session.resize(cols, rows);
		void this.screenModel.resize(cols, rows);
	}

	signal(signal: NodeJS.Signals): void {
		this.session.kill(signal);
	}

	async screen(history = 0): Promise<string> {
		await this.screenModel.flush();
		const snapshot = this.screenModel.snapshot();
		const lines = [
			...snapshot.scrollback.slice(Math.max(0, snapshot.scrollback.length - history)),
			...snapshot.visibleGrid,
		];
		return lines.join("\n").replace(/\s+$/, "");
	}
}

/**
 * A holder link whose terminals live in this process, over the existing pty package (native PTY, Bun terminal or
 * pipe fallback). Stand-in for the separate holder process: terminals end when this process ends.
 *
 * pi-pty loads on the first spawn (`./pty.lazy.ts`), so importing this module keeps `@xterm/headless` off the graph.
 */
export function createInProcessHolderLink(): HolderLink {
	const live = new Set<InProcessTerminal>();
	return {
		async spawn(req: HolderSpawnRequest): Promise<HeldTerminal> {
			const { createTerminalSession, TerminalScreen } = await loadPty();
			const session = createTerminalSession({
				command: req.command,
				args: req.args,
				cwd: req.cwd,
				env: req.env,
				cols: req.cols,
				rows: req.rows,
			});
			const screen = new TerminalScreen({ cols: req.cols, rows: req.rows, scrollback: SCREEN_SCROLLBACK });
			const terminal = new InProcessTerminal(req.id, session, screen);
			live.add(terminal);
			terminal.onExit(() => live.delete(terminal));
			return terminal;
		},
		async close(): Promise<void> {
			for (const terminal of live) terminal.signal("SIGKILL");
		},
	};
}
