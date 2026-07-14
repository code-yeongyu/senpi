import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY fixture requires a host prebuild");
}

const events = [];
let output = "";
const session = nativePty.native.startPtySession(
	{
		command: "sh",
		args: ["-lc", "printf LATE_CALLBACK_MARKER"],
		cols: 80,
		rows: 24,
	},
	(chunk) => {
		output += String(chunk);
		events.push("data");
	},
);
const wait = session.waitExit().then(() => events.push("waitExit"));

Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_500);
await wait;

process.stdout.write(`${JSON.stringify({ events, output })}\n`);
