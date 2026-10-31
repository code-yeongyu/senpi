import type { CommittedWrite } from "../commit.ts";
import { parseJsonlTransactionValue } from "./io.ts";

/** What replaying one complete line kept (the whole line, or a record glued after a torn fragment) and set aside. */
export interface ReplayedLine {
	readonly kept: string | undefined;
	readonly setAside: string | undefined;
}

/** The records of a v4 file that replay, and the damaged bytes that do not (a torn final line included). */
export interface ReplayedLines {
	readonly kept: string;
	readonly setAside: readonly string[];
}

type Replay = (writes: readonly CommittedWrite[]) => void;

const RECORD_START = '{"kind":"';
const NOT_JSON = Symbol("not JSON");
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error) {
		if (error instanceof SyntaxError) return NOT_JSON;
		throw error;
	}
}

function replays(writes: readonly CommittedWrite[], replay: Replay): boolean {
	try {
		replay(writes);
	} catch (error) {
		if (error instanceof Error) return false;
		throw error;
	}
	return true;
}

function salvagedRecord(text: string, replay: Replay): boolean {
	const value = parseJson(text);
	if (value === NOT_JSON) return false;
	let writes: CommittedWrite[];
	try {
		writes = parseJsonlTransactionValue(value);
	} catch (error) {
		if (error instanceof Error) return false;
		throw error;
	}
	return replays(writes, replay);
}

/**
 * Replays one complete line. A line that is not JSON was damaged by a torn write: the first suffix that starts a
 * record and replays is kept (an append torn by a full disk and followed by the next append leaves
 * `<fragment><whole record>` on one line), the rest is set aside. A JSON line this version cannot frame (an unknown
 * write kind, possibly from a newer version) throws, so the session is refused rather than stripped of it. A framed
 * line that does not replay (a reused sequence, a missing parent) is set aside. `replay` validates before applying.
 */
export function replayLine(line: string, replay: Replay): ReplayedLine {
	const whole = parseJson(line);
	if (whole !== NOT_JSON) {
		const writes = parseJsonlTransactionValue(whole);
		return replays(writes, replay) ? { kept: line, setAside: undefined } : { kept: undefined, setAside: `${line}\n` };
	}
	for (let at = line.indexOf(RECORD_START, 1); at !== -1; at = line.indexOf(RECORD_START, at + 1)) {
		const starts = at > 1 && line[at - 1] === "[" ? [at - 1, at] : [at];
		for (const start of starts) {
			if (salvagedRecord(line.slice(start), replay)) {
				return { kept: line.slice(start), setAside: line.slice(0, start) };
			}
		}
	}
	return { kept: undefined, setAside: `${line}\n` };
}

/**
 * Replays the records after the header line. One damaged record never refuses the session: it is set aside and every
 * record around it is kept. A record this version cannot frame throws, and the caller names its line.
 */
export function replayV4Lines(
	lines: readonly string[],
	tornTail: string | undefined,
	replay: Replay,
	refuse: (lineNumber: number, cause: unknown) => Error,
): ReplayedLines {
	const kept = lines.slice(0, 1);
	const setAside: string[] = [];
	for (let index = 1; index < lines.length; index++) {
		let replayed: ReplayedLine;
		try {
			replayed = replayLine(lines[index] ?? "", replay);
		} catch (error) {
			throw refuse(index + 1, error);
		}
		if (replayed.kept !== undefined) kept.push(replayed.kept);
		if (replayed.setAside !== undefined) setAside.push(replayed.setAside);
	}
	if (tornTail !== undefined) setAside.push(tornTail);
	return { kept: kept.map((line) => `${line}\n`).join(""), setAside };
}
