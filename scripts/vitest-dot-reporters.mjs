import { DotReporter } from "vitest/node";

/**
 * Off a TTY, Vitest's dot reporter writes one character per finished test and ends the line only when the run ends,
 * so packages/ai's 24k tests became one 532 KB log line. `gh run view --log` stops reading a log at its first line
 * over 64 KiB (Go's bufio.Scanner limit): every release log it printed ended at packages/ai's RUN banner and read as
 * a silent hang, while the job's full log shows that suite passing in about 90 s (senpi#2291, senpi#1888).
 * Ending the line every RESULTS_PER_LINE results keeps each line near 1 KB.
 */
export const RESULTS_PER_LINE = 100;

class LineBoundedDotReporter extends DotReporter {
	#results = 0;

	onTestRunStart(specifications) {
		this.#results = 0;
		super.onTestRunStart(specifications);
	}

	onTestCaseResult(test) {
		super.onTestCaseResult(test);
		// DotReporter prints a non-pending result immediately when it is not on a TTY; a TTY redraws in place instead.
		if (this.isTTY || test.result().state === "pending") return;
		this.#results += 1;
		if (this.#results % RESULTS_PER_LINE === 0) this.ctx.logger.outputStream.write("\n");
	}
}

/** Every workspace's Vitest reporters: compact dots, plus failure annotations under GitHub Actions. */
export function dotReporters(env = process.env) {
	return env.GITHUB_ACTIONS ? [new LineBoundedDotReporter(), "github-actions"] : [new LineBoundedDotReporter()];
}
