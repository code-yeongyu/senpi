/**
 * Canonical expected-snapshot builder: the expected entry list of a session, built OUTSIDE the server
 * response path. It streams the session file one line at a time (holding at most one parsed line),
 * skips the header, applies the built package's real `describeUsageLimitEntry` and yields entries in
 * file order. A last line without its terminating newline is a torn tail (`torn_tail`). Used where a
 * paged walk must be compared and a legacy un-paged `get_entries` would exceed the 64 MiB record limit.
 */
import { createReadStream, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { QaFailure } from "./qa-failure.mjs";

const BUILT_USAGE_LIMIT = fileURLToPath(new URL("../../../dist/core/retry-fallback/usage-limit.js", import.meta.url));
const NEWLINE = 0x0a;

/** Lines of a file as `{ line, terminated }`, read in chunks and split on LF without buffering the file. */
export async function* readLines(path) {
	let pending = Buffer.alloc(0);
	for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
		let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
		for (let newline = data.indexOf(NEWLINE); newline !== -1; newline = data.indexOf(NEWLINE)) {
			yield { line: data.subarray(0, newline).toString("utf8"), terminated: true };
			data = data.subarray(newline + 1);
		}
		pending = Buffer.from(data);
	}
	if (pending.length > 0) yield { line: pending.toString("utf8"), terminated: false };
}

let builtTransform;
/** The real transform from `dist`; the builder never re-implements it. */
export async function loadUsageLimitTransform() {
	if (builtTransform !== undefined) return builtTransform;
	if (!existsSync(BUILT_USAGE_LIMIT)) {
		throw new QaFailure("built_package_missing", `${BUILT_USAGE_LIMIT} not found; run npm run build in packages/coding-agent`);
	}
	const module = await import(pathToFileURL(BUILT_USAGE_LIMIT).href);
	builtTransform = module.describeUsageLimitEntry;
	return builtTransform;
}

export async function* streamExpectedEntries(path, { readLines: lines = readLines, transform } = {}) {
	const describe = transform ?? (await loadUsageLimitTransform());
	let lineNumber = 0;
	for await (const { line, terminated } of lines(path)) {
		lineNumber += 1;
		if (!terminated) throw new QaFailure("torn_tail", `line ${lineNumber} of ${path} has no terminating newline`);
		if (line.trim().length === 0) continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			throw new QaFailure("malformed_line", `line ${lineNumber} of ${path} is not JSON`);
		}
		if (entry.type === "session") continue;
		yield describe(entry);
	}
}

export async function collectExpected(path, options) {
	const entries = [];
	for await (const entry of streamExpectedEntries(path, options)) entries.push(entry);
	return entries;
}
