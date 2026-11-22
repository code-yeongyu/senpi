import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY fixture requires a host prebuild");
}

const CHUNKS_AFTER_WRITE = 20;
let written = false;
let chunksAfterWrite = 0;
let markFlowing;
const flowing = new Promise((resolve) => {
	markFlowing = resolve;
});
const session = nativePty.native.startPtySession(
	{
		command: "sh",
		args: ["-c", "while :; do printf '%s\\n' 0123456789012345678901234567890123456789; done"],
		cols: 80,
		rows: 24,
	},
	() => {
		if (!written) return;
		chunksAfterWrite += 1;
		if (chunksAfterWrite === CHUNKS_AFTER_WRITE) markFlowing(true);
	},
);

session.write(`${"x".repeat(63)}\n`.repeat(16_384));
written = true;

let deadline;
const outputFlowedAfterWrite = await Promise.race([
	flowing,
	new Promise((resolve) => {
		deadline = setTimeout(() => resolve(false), 5_000);
	}),
]);
clearTimeout(deadline);
session.kill("SIGKILL");
await session.waitExit();

process.stdout.write(`${JSON.stringify({ outputFlowedAfterWrite })}\n`);
