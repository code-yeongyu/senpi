// Shell PreToolUse hook for the G1 order-once characterization (test/characterization/tool-order-once.test.ts).
// argv[2] is the trace file: the hook appends "pre" to it and keeps the stdin it received beside it. It prints
// nothing, so the call is neither blocked nor rewritten.
import { appendFileSync, writeFileSync } from "node:fs";

const tracePath = process.argv[2];
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	stdin += chunk;
});
process.stdin.on("end", () => {
	appendFileSync(tracePath, "pre\n");
	writeFileSync(`${tracePath}.pre-stdin.json`, stdin);
});
