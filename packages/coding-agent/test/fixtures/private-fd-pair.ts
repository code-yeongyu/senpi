import { spawn } from "node:child_process";
import { fstatSync } from "node:fs";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import { parseTable } from "../../src/private-fds.ts";
import { inheritedDuplex } from "../../src/utils/inherited-duplex.ts";

// Test-only proof injection: the release constant stays false until the named proof job passes.
const parsed = parseTable('{"a":[5,6]}', { proven: { bun: process.versions.bun! } });
if (process.argv[2] === "hop") {
	const transfer = preparePrivateFdSpawn(
		{ stdio: ["ignore", "inherit", "inherit"] },
		{},
		{ kind: "entries", entries: parsed.entries },
	);
	const child = spawn(process.execPath, ["engine"], transfer.options);
	transfer.close();
	child.once("error", () => process.exit(2));
	child.once("exit", (code) => process.exit(code ?? 2));
} else {
	const pair = parsed.entries.get("a");
	if (pair == null || typeof pair === "number") throw new Error("pair unavailable");
	const channel = inheritedDuplex(pair);
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
