/**
 * senpi#6282 fixture child: started with a startup hand-off that lists filler slots it never inherited, as a host
 * is after an exec hop between its spawn and its first entry. Its stderr stream exists first, then it loads the real
 * startup stub, then writes to stderr the way the internal bootstrap does, then reports which listed slots it still holds.
 */
import "./startup-filler-stderr-first.ts";
import "../../src/modes/rpc/host-startup-beacon.ts";
import { fstatSync } from "node:fs";

process.stderr.write("stderr-ok\n");
function isOpen(fd: number): boolean {
	try {
		fstatSync(fd);
		return true;
	} catch {
		return false;
	}
}

const held = Array.from({ length: 13 }, (_, index) => index + 3).filter(isOpen);
process.stdout.write(`${JSON.stringify({ held })}\n`);
