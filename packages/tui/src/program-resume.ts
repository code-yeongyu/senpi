/**
 * OSC 7577 Program Resume Protocol (rev 0.5): a program tells its terminal the command that resumes it after the
 * terminal restarts. https://www.superlogical.com/rex/docs/build/program-resume
 */
import { createHash } from "node:crypto";

export type ProgramResumeReport =
	| { pid: number; time: number; argv: readonly string[]; cwd?: string }
	| { pid: number; time: number; clear: true };

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
// C0, DEL and C1 controls make the terminal reject the whole report.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
// The minimum report length every terminal must accept, counted over the whole sequence.
const MAX_SEQUENCE_BYTES = 2048;
const MAX_ARGV_ELEMENTS = 64;

export function isProgramResumeToken(token: string): boolean {
	return TOKEN_PATTERN.test(token);
}

function isReportableCommand(argv: readonly string[]): boolean {
	const program = argv[0];
	if (program === undefined || program === "" || program.startsWith("-") || argv.length > MAX_ARGV_ELEMENTS)
		return false;
	if (program.includes("/") && !program.startsWith("/")) return false;
	return argv.every((element) => !CONTROL_PATTERN.test(element));
}

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

/**
 * Build the OSC 7577 report, or undefined when the token is malformed or the command cannot be reported (the caller
 * then sends `clear` so the terminal does not resume an earlier command in its place). The token only enters the
 * SHA-256 `mac`; it is never part of the sequence.
 */
export function encodeProgramResume(report: ProgramResumeReport, token: string): string | undefined {
	if (!isProgramResumeToken(token)) return undefined;
	const pairs = [`pid=${report.pid}`, `time=${report.time}`];
	if ("clear" in report) pairs.push("clear=1");
	else {
		if (!isReportableCommand(report.argv)) return undefined;
		pairs.push(`argv=${report.argv.map(base64).join(",")}`);
		if (report.cwd !== undefined) {
			if (!report.cwd.startsWith("/") || CONTROL_PATTERN.test(report.cwd)) return undefined;
			pairs.push(`cwd=${base64(report.cwd)}`);
		}
	}
	const body = pairs.join(":");
	const mac = createHash("sha256").update(`${body}:${token}`, "utf8").digest("hex");
	const sequence = `\x1b]7577;${body}:mac=${mac}\x1b\\`;
	return Buffer.byteLength(sequence, "utf8") > MAX_SEQUENCE_BYTES ? undefined : sequence;
}
