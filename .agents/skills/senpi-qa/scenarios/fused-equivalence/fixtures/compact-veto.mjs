// E12 fixture: session_before_compact vetoes the first compaction and lets every later one through. Each decision is
// appended to compact-decisions.log in the session cwd (an O5 effect).
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function compactVeto(pi) {
	let seen = 0;
	pi.on("session_before_compact", (_event, ctx) => {
		seen++;
		const decision = seen === 1 ? "veto" : "allow";
		appendFileSync(join(ctx.cwd, "compact-decisions.log"), `${seen}:${decision}\n`);
		return decision === "veto" ? { cancel: true } : undefined;
	});
}
