import fs from "node:fs";
import { platform } from "node:os";
import { wrapTmuxPassthrough } from "./terminal-image.ts";

interface ClipboardTty {
	write(data: string): void;
	close(): void;
}

interface ClipboardOsc52Options {
	write?: (data: string) => void;
	openTty?: () => ClipboardTty;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

function openClipboardTty(): ClipboardTty {
	const fd = fs.openSync("/dev/tty", "w");
	return {
		write: (data) => {
			fs.writeSync(fd, data);
		},
		close: () => fs.closeSync(fd),
	};
}

/** Deliver clipboard escapes even when the launcher or TUI diverts stdout. */
export function writeClipboardOsc52(text: string, options: ClipboardOsc52Options = {}): void {
	const sequence = `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;
	const output = (options.env ?? process.env).TMUX ? wrapTmuxPassthrough(sequence) : sequence;
	if ((options.platform ?? platform()) !== "win32") {
		try {
			const tty = (options.openTty ?? openClipboardTty)();
			try {
				tty.write(output);
			} finally {
				tty.close();
			}
			return;
		} catch {
			// No controlling terminal (or it disappeared): retain the caller's output route.
		}
	}
	(
		options.write ??
		((data) => {
			process.stdout.write(data);
		})
	)(output);
}
