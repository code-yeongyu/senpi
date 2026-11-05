import { closeSync, fstatSync, openSync } from "node:fs";

const opened: number[] = [];
let fd: number | undefined;
for (let attempt = 0; attempt < 5; attempt++) {
	const candidate = openSync(import.meta.filename, "r");
	opened.push(candidate);
	if (candidate >= 5 && candidate <= 64) {
		fd = candidate;
		break;
	}
}
if (fd === undefined) throw new Error("no in-range fixture descriptor");
const fixtureFd = fd;
const fixtureIno = fstatSync(fixtureFd).ino;
// POSIX reuses a freed descriptor number for the next open, so "still open" must also mean "still this file".
const stillFixture = (): boolean => {
	try {
		return fstatSync(fixtureFd).ino === fixtureIno;
	} catch {
		return false;
	}
};
let dlopenCalls = 0;
const builtin = process.getBuiltinModule;
process.getBuiltinModule = (name: string) =>
	name === "bun:ffi"
		? {
				FFIType: { i32: 0, ptr: 1, u32: 2 },
				dlopen() {
					dlopenCalls++;
					throw new Error("native library unavailable");
				},
			}
		: builtin(name);
Object.defineProperty(process, "platform", { value: "win32" });
process.env.SENPI_PRIVATE_FDS = JSON.stringify({ a: [fd, fd] });
delete process.env.SENPI_PRIVATE_FDS_FINAL;
try {
	// Fresh process: bootstrap capture must survive a native loader failure, not merely a parser call.
	const captured = await import("../../src/private-fds.ts");
	const forward = captured.takePrivateDescriptors();
	process.stdout.write(
		JSON.stringify({
			imported: true,
			declared: captured.privateChannelDeclared("a"),
			entry: forward.kind === "entries" ? forward.entries.get("a") : "unparseable",
			dlopenCalls,
			discarded: !stillFixture(),
		}),
	);
} catch {
	process.stdout.write(JSON.stringify({ imported: false, dlopenCalls }));
} finally {
	// Capture closes a handle whose inherit flag could not be cleared; close only what is still ours.
	for (const descriptor of opened) if (descriptor !== fixtureFd || stillFixture()) closeSync(descriptor);
}
