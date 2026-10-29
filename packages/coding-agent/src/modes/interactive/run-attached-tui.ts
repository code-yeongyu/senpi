import { TuiAltScreen } from "@earendil-works/pi-tui";
import { getAgentDir } from "../../config.ts";
import { markModeCrashHandler } from "../../core/bootstrap-crash-listeners.ts";
import { AttachedTui, validateAttachTerminal } from "./attach.ts";
import { initTheme, stopThemeWatcher } from "./theme/theme.ts";
import { createInteractiveTui } from "./tui-renderer.ts";

/** Lazy CLI presentation boundary, parallel to the ordinary interactive mode. */
export async function runAttachedTui(options: {
	readonly address: string;
	readonly session: string;
	readonly tuiMode?: "regular" | "fullscreen";
	readonly theme?: string;
}): Promise<void> {
	validateAttachTerminal(process.stdin.isTTY, process.stdout.isTTY);
	initTheme(options.theme);
	const ui = createInteractiveTui({
		tuiMode: options.tuiMode ?? "regular",
		showHardwareCursor: false,
		logDirectory: getAgentDir(),
	});
	let restored = false;
	const restore = () => {
		if (restored) return;
		restored = true;
		try {
			ui.stop();
		} finally {
			stopThemeWatcher();
		}
	};
	// The one crash path: it never defers to another listener. It restores the terminal, then the
	// process dies non-zero with the original error. Marked, so the bootstrap listener defers to it.
	const crash = (error: unknown) => {
		try {
			restore();
		} finally {
			console.error(error);
			process.exit(1);
		}
	};
	markModeCrashHandler(crash);
	process.prependListener("uncaughtException", crash);
	process.prependListener("unhandledRejection", crash);
	let finish: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let interrupt: () => void = () => {};
	const interrupted = new Promise<"interrupted">((resolve) => {
		interrupt = () => resolve("interrupted");
	});
	const view = new AttachedTui(ui, finish);
	// A signal ends the presentation at once, also while connect() still waits on the endpoint. Once it
	// is leaving, the release can wait on a silent endpoint: a further signal restores the terminal
	// (idempotently) and exits at once, non-zero.
	let leaving = false;
	const stop = (exitCode: number) => {
		if (leaving) {
			restore();
			process.exit(exitCode);
		}
		leaving = true;
		finish();
		interrupt();
	};
	const onSigterm = () => stop(143);
	const onSigint = () => stop(130);
	process.on("SIGTERM", onSigterm);
	process.on("SIGINT", onSigint);
	ui.addChild(view);
	if (ui instanceof TuiAltScreen) ui.setLayoutRoot(view.layoutRoot);
	ui.setFocus(view);
	ui.start();
	try {
		const outcome = await Promise.race([
			view.connect(options.address, options.session).then(() => "connected" as const),
			interrupted,
		]);
		if (outcome === "connected") await done;
	} finally {
		leaving = true;
		try {
			// The terminal comes back first: the release below can wait out its whole deadline.
			restore();
		} finally {
			// Even if restoring throws, the release is sent and the listeners come off.
			try {
				await view.close();
			} finally {
				process.off("SIGTERM", onSigterm);
				process.off("SIGINT", onSigint);
				process.off("uncaughtException", crash);
				process.off("unhandledRejection", crash);
			}
		}
	}
}
