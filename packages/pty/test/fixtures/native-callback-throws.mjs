import { nativePty } from "../../native/index.js";

if (nativePty.native === null) {
	throw new Error("native PTY fixture requires a host prebuild");
}

const session = nativePty.native.startPtySession(
	{
		command: "sh",
		args: ["-lc", "printf native-callback-data"],
		cols: 80,
		rows: 24,
	},
	() => {
		throw new Error("SENPI_NATIVE_CALLBACK_FAILURE");
	},
);

await session.waitExit();
process.stdout.write("WAIT_RESOLVED_AFTER_CALLBACK_FAILURE\n");
