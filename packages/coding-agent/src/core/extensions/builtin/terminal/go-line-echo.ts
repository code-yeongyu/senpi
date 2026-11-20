/**
 * Drops the echo of a gated command's go-line from the front of its output (senpi#7120).
 *
 * A gated command's PTY runs a shim that reads one go-line before it execs the command (`tools/spawn.ts`). A native
 * PTY's line discipline echoes that line, and since the command has not run yet, the echo leads the output. The go-line is a random token, so the
 * output can only start with it through that echo: this filter holds output while it is still a prefix of the echo,
 * drops the echo when it is there (with the `\r\n` ONLCR makes of the newline, or a bare `\n`), and passes everything
 * through untouched from the first byte that rules the echo out.
 */
export class GoLineEchoFilter {
	readonly #echoes: readonly string[];
	#held = "";
	#settled = false;

	constructor(goLine: string) {
		this.#echoes = [`${goLine}\r\n`, `${goLine}\n`];
	}

	/** The part of `text` that is output, in order; empty while the front is still undecided. */
	push(text: string): string {
		if (this.#settled) return text;
		const front = this.#held + text;
		const echo = this.#echoes.find((candidate) => front.startsWith(candidate));
		if (echo !== undefined) return this.#settle(front.slice(echo.length));
		if (this.#echoes.some((candidate) => candidate.startsWith(front))) {
			this.#held = front;
			return "";
		}
		return this.#settle(front);
	}

	/** Whatever is still held, once no more output can follow. */
	flush(): string {
		return this.#settle(this.#held);
	}

	#settle(output: string): string {
		this.#settled = true;
		this.#held = "";
		return output;
	}
}
