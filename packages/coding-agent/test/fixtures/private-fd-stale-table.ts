// A table naming in-range handles this process never opened. On Windows the receipt clear fails for an
// unopened handle, so capture discards (closes) it, which must surface as EBADF, never a CRT abort.
const captured = await import("../../src/private-fds.ts");
const forward = captured.takePrivateDescriptors();
process.stdout.write(
	JSON.stringify({
		pair: forward.kind === "entries" ? forward.entries.get("pair") : "unparseable",
		bare: forward.kind === "entries" ? forward.entries.get("bare") : "unparseable",
	}),
);

export {};
