/**
 * OSC 7577 Program Resume Protocol (senpi#7493): interactive mode tells a supporting terminal how to resume the
 * current session after the terminal restarts. https://www.superlogical.com/rex/docs/build/program-resume
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { encodeProgramResume } from "@earendil-works/pi-tui";
import { APP_COMMAND } from "../../config.ts";
import type { SessionManager } from "../../core/session-manager.ts";

export interface ProgramResumeTarget {
	argv: readonly string[];
	cwd: string;
}

export function programResumeTarget(
	sessionManager: Pick<SessionManager, "isPersisted" | "getSessionFile" | "getCwd">,
): ProgramResumeTarget | undefined {
	if (!sessionManager.isPersisted()) return undefined;
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	const cwd = sessionManager.getCwd();
	return {
		argv: [APP_COMMAND, "--session", resolve(sessionFile)],
		cwd: isAbsolute(cwd) ? cwd : resolve(cwd),
	};
}

export interface ProgramResumeReporterDependencies {
	token: string;
	pid: number;
	now: () => number;
	write: (sequence: string) => void;
}

export class ProgramResumeReporter {
	private reported: string | undefined;

	constructor(private readonly deps: ProgramResumeReporterDependencies) {}

	/**
	 * Report `target`, or clear the record when there is none or it cannot be reported. `refresh` reports an unchanged
	 * command again, for when another program may have replaced the record while this one did not own the terminal.
	 */
	sync(target: ProgramResumeTarget | undefined, options: { refresh?: boolean } = {}): void {
		const key = target === undefined ? undefined : JSON.stringify(target);
		if (key !== undefined && key === this.reported && !options.refresh) return;
		if (target !== undefined) {
			const sequence = encodeProgramResume({ ...this.stamp(), argv: target.argv, cwd: target.cwd }, this.deps.token);
			if (sequence !== undefined) {
				this.deps.write(sequence);
				this.reported = key;
				return;
			}
		}
		this.clear();
	}

	/** Remove the record when the user ends the session; never on SIGHUP/SIGTERM, when the record is needed. */
	clear(): void {
		if (this.reported === undefined) return;
		const sequence = encodeProgramResume({ ...this.stamp(), clear: true }, this.deps.token);
		if (sequence !== undefined) this.deps.write(sequence);
		this.reported = undefined;
	}

	private stamp(): { pid: number; time: number } {
		return { pid: this.deps.pid, time: Math.floor(this.deps.now() / 1000) };
	}
}
