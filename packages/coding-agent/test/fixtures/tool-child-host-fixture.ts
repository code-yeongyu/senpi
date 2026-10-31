// A stand-in host for the orphan tests (senpi#3566 todo 4, review HIGH 2): starts a real tool child, has it launch an
// owned own-group sleep and an inherited sleep, prints their pids, then waits to be killed.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolChildClient } from "../../src/modes/rpc/tool-child/client.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) throw new Error("usage: tool-child-host-fixture <dir>");
const resolver = pathToFileURL(resolve(import.meta.dirname, "../../src/experimental/source-resolver.ts")).href;
const client = new ToolChildClient({
	dir,
	cwd: dir,
	command: {
		command: process.execPath,
		args: ["--import", resolver, resolve(import.meta.dirname, "tool-child-fixture.ts")],
	},
});
await client.start();
const owned = (await client.run("spawnSleep", null)) as { pid: number };
const inherited = (await client.run("inheritedSleep", null)) as { pid: number };
console.log(JSON.stringify({ childPid: client.pid, owned: owned.pid, inherited: inherited.pid }));
setInterval(() => {}, 60_000);
