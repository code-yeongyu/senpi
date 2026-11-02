import { spawn } from "node:child_process";
import { takeInheritedPrivateChannel } from "../../src/private-fds.ts";

export default function privateFdExtension(): void {
	const channel = takeInheritedPrivateChannel("sample-channel");
	if (!channel) return;
	channel.on("error", () => channel.destroy());
	channel.on("data", (chunk: Buffer) => {
		if (chunk.toString() === "inspect") {
			const probe = spawn(
				process.execPath,
				[
					"-e",
					"try {require('node:fs').writeSync(5,'leaked');process.exit(1)} catch {process.exit(process.env.SENPI_PRIVATE_FDS ? 2 : 0)}",
				],
				{
					stdio: "ignore",
				},
			);
			probe.once("exit", (code) => channel.write(JSON.stringify({ childExit: code })));
		} else {
			channel.write(`echo:${chunk.toString()}`);
		}
	});
}
