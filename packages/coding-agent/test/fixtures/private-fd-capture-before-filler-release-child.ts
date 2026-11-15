/**
 * senpi#6769 fixture child: evaluates the private-descriptor capture BEFORE the filler release, the order the bundled
 * `dist/bundle/cli.js` ends up with (the release's side effect sits in the entry body, which runs after every imported
 * chunk). Started like a supervisor's host child: filler pipes, the startup pipe at 16, and the private socket in a
 * slot the hand-off still lists as a filler. It writes one line on the claimed channel and reports what happened.
 */
import { takeInheritedPrivateChannel } from "../../src/private-fds.ts";
import "../../src/private-fd-startup-release.ts";

const channel = takeInheritedPrivateChannel("memory-sync");
if (channel === undefined) {
	process.stdout.write("no-channel\n");
	process.exit(0);
}
channel.on("error", (error: NodeJS.ErrnoException) => {
	process.stdout.write(`channel-error:${error.code ?? error.message}\n`);
	process.exit(0);
});
channel.end("child-ok\n", () => {
	process.stdout.write("written\n");
	process.exit(0);
});
