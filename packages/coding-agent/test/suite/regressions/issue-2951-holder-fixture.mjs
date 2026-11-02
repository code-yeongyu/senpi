import { parentPort, workerData } from "node:worker_threads";
import { holdSessionFile } from "../../../src/core/session-holders.ts";

const [file, id, cwd] = workerData ?? process.argv.slice(2);
const hold = holdSessionFile(file, id, { cwd, expectExisting: true });
if (parentPort) {
	parentPort.on("message", () => {
		hold.release();
		parentPort.close();
	});
	parentPort.postMessage(process.pid);
} else {
	process.stdin.once("data", () => {
		hold.release();
		process.exit(0);
	});
	process.stdout.write("HELD\n");
}
