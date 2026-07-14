import { parentPort } from "node:worker_threads";
import { nativePty } from "../../native/index.js";

if (parentPort === null) {
	throw new Error("native worker fixture requires a parent port");
}
if (nativePty.native === null) {
	throw new Error("native worker fixture requires a host prebuild");
}

nativePty.native.startPtySession(
	{
		command: "sh",
		args: ["-lc", "echo PID=$$; while :; do printf 1234567890123456789012345678901234567890; done"],
		cols: 80,
		rows: 24,
	},
	(chunk) => {
		const match = /PID=(\d+)/.exec(String(chunk));
		if (match?.[1] !== undefined) parentPort.postMessage(Number(match[1]));
	},
);
