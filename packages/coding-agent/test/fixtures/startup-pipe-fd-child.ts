/**
 * senpi#4602 fixture child: loads the real startup stub first (as every host entry does), then reports its
 * open descriptors and writes a marker to the #4749 private descriptor it was given, if any.
 */
import "../../src/modes/rpc/host-startup-beacon.ts";
import { fstatSync, readdirSync, writeSync } from "node:fs";

const privateFd = Number(process.argv[2]);
if (Number.isInteger(privateFd) && privateFd > 2) writeSync(privateFd, "private-ok");
const fds = readdirSync("/dev/fd")
	.map(Number)
	.filter((fd) => {
		try {
			fstatSync(fd);
			return true;
		} catch {
			return false;
		}
	})
	.sort((a, b) => a - b);
process.stdout.write(`${JSON.stringify({ fds })}\n`);
