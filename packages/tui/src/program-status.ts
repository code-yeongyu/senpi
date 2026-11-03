/**
 * OSC 7501 Program Status Protocol (rev 0.4): a program tells its terminal whether it is idle, working,
 * blocked on the user, done or failed. https://control-codes.page/proposals/osc-7501/
 */

export type ProgramStatusState = "idle" | "working" | "blocked" | "done" | "error";
export type ProgramStatusKind = "permission" | "question" | "auth";

export interface ProgramStatus {
	state: ProgramStatusState;
	/** How the user must act; only sent with `blocked`. */
	kind?: ProgramStatusKind;
	/** One line on what the program is doing or waiting for. */
	message?: string;
}

const MAX_MESSAGE_BYTES = 2048;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;
// C0, DEL and C1 controls: a decoded msg holding any of them makes the terminal drop the whole report.
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]+/g;
// Bidi overrides/isolates and invisible formatting, which a terminal may show outside the grid.
const INVISIBLE_FORMATTING_PATTERN =
	/[\u00ad\u061c\u180e\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function sanitizeMessage(message: string): string {
	return message.replace(INVISIBLE_FORMATTING_PATTERN, "").replace(CONTROL_PATTERN, " ").replace(/\s+/g, " ").trim();
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let bytes = 0;
	let result = "";
	for (const char of text) {
		bytes += Buffer.byteLength(char, "utf8");
		if (bytes > maxBytes) break;
		result += char;
	}
	return result;
}

/**
 * Build the OSC 7501 report for `status`, or the `state=clear` report that removes every record when it is
 * undefined. `app` is repeated in every report because each one replaces its record; an app name outside the
 * protocol's charset or length is left out rather than sent for the terminal to discard.
 */
export function encodeProgramStatus(status: ProgramStatus | undefined, app?: string): string {
	if (status === undefined) return "\x1b]7501;state=clear\x1b\\";
	const pairs = [`state=${status.state}`];
	if (status.state === "blocked" && status.kind !== undefined) pairs.push(`kind=${status.kind}`);
	if (app !== undefined && APP_PATTERN.test(app)) pairs.push(`app=${app}`);
	const message = status.message === undefined ? "" : truncateUtf8(sanitizeMessage(status.message), MAX_MESSAGE_BYTES);
	if (message.length > 0) pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
	return `\x1b]7501;${pairs.join(":")}\x1b\\`;
}
