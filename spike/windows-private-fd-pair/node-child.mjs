// S0 item 6: a Node child (standing in for the desktop's Node SEA backend) adopts fd 9 read-only and fd 10
// write-only as net.Sockets (falling back to fs streams if uv_pipe_open refuses a synchronous child end),
// then spawns an ordinary grandchild and closes fd 10. The driver must see EOF on fd 10 while the
// grandchild lives, which shows Node's startup uv_disable_stdio_inheritance cleared fd 10's inherit flag.
import { spawn } from "node:child_process";
import { createReadStream, write } from "node:fs";
import { Socket } from "node:net";

const say = (item, data) => process.stdout.write(`S0 ${JSON.stringify({ item, pid: process.pid, ...data })}\n`);
let reader;
let writeLine;
let closeWriter;
let adoption;
try {
	reader = new Socket({ fd: 9, readable: true, writable: false });
	const out = new Socket({ fd: 10, readable: false, writable: true });
	writeLine = (s) => out.write(s);
	closeWriter = () => out.destroy();
	adoption = "net.Socket";
} catch (error) {
	reader = createReadStream("", { fd: 9 });
	writeLine = (s) => write(10, s, () => {});
	closeWriter = () => {};
	adoption = `fs (net.Socket threw: ${error.message})`;
}
say("item6-adopt", { adoption });
let buffered = "";
reader.on("data", (chunk) => {
	buffered += chunk.toString();
	if (!buffered.includes("ping\n")) return;
	writeLine("pong\n");
	const grandchild = spawn(process.argv[2], ["sleep"], { stdio: "ignore" });
	grandchild.once("spawn", () => {
		say("item6-grandchild", { grandchildPid: grandchild.pid });
		closeWriter();
		setTimeout(() => {
			grandchild.kill();
			process.exit(0);
		}, 8_000);
	});
});
writeLine("hello\n");
