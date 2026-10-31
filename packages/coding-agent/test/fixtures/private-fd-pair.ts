import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { inheritedDuplex } from "../../src/utils/inherited-duplex.ts";
import { parseTable as oldParseTable } from "./private-fd-old-parser.ts";

// Test-only receipt boundary: save the actual forwarded selector before production capture removes it.
const encoded = process.env.SENPI_PRIVATE_FDS ?? "";
const { parseTable } = await import("../../src/private-fds.ts");
const { preparePrivateFdSpawn } = await import("../../src/private-fd-spawn.ts");
const local = process.argv[2]?.startsWith("local-");
// Test-only proof injection; the local socketpair exercises composition without pretending to prove Windows.
const bunVersion = process.versions.bun;
if (bunVersion === undefined) throw new Error("private-fd-pair fixture must run under Bun");
const parsed = parseTable(encoded, {
	proven: { bun: bunVersion },
	...(local
		? { platform: "win32" as const, isPipe: (fd: number) => fstatSync(fd).isSocket(), clearInherit: () => true }
		: {}),
});
if (oldParseTable(encoded).entries.get("a") !== null) throw new Error("old parser accepted a pair");
if (process.argv[2] === "hop" || process.argv[2] === "local-hop") {
	const transfer = preparePrivateFdSpawn(
		{ stdio: ["ignore", "inherit", "inherit"] },
		{},
		{ kind: "entries", entries: parsed.entries },
	);
	const child = spawn(process.execPath, local ? [import.meta.filename, "local-engine"] : ["engine"], transfer.options);
	transfer.close();
	child.once("error", () => process.exit(2));
	child.once("exit", (code) => process.exit(code ?? 2));
} else {
	const value: unknown = parsed.entries.get("a");
	if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== "number" || typeof value[1] !== "number")
		throw new Error("pair unavailable");
	const pair: readonly [number, number] = [value[0], value[1]];
	// Test the future wire shape without changing main's single-descriptor signature in the seam.
	const channel: ReturnType<typeof inheritedDuplex> = Reflect.apply(inheritedDuplex, undefined, [pair]);
	if (!channel) throw new Error("pair adoption failed");
	let received = "";
	channel.on("data", (chunk: Buffer) => {
		received += chunk.toString();
	});
	channel.once("end", () => channel.end(`echo:${received}`, () => channel.destroy()));
	channel.once("close", () => {
		const closed = pair.map((fd) => {
			try {
				fstatSync(fd);
				return false;
			} catch {
				return true;
			}
		});
		process.stdout.write(JSON.stringify({ closed }));
	});
}
