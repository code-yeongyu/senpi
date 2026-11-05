/**
 * senpi#4602 fixture: runs in a fresh process so it controls its own descriptor table. It frees low
 * descriptors (the macOS libuv abort precondition), places a #4749 private descriptor at its own number
 * below 16 where the runtime leaves such a slot free, spawns a stub-loading child with the startup pipe at 16, and prints one JSON report: the exact
 * descriptor sets of the parent before and after the spawn and of the child, plus a control child's.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { preparePrivateFdSpawn } from "../../src/private-fd-spawn.ts";
import { encodeStartupHandOff, STARTUP_EVENT_FD } from "../../src/modes/rpc/host-startup-wire.ts";
import { releaseStartupFillers, withStartupPipe } from "../../src/private-fd-startup-fillers.ts";

const childScript = join(import.meta.dirname, "startup-pipe-fd-child.ts");
const [privateFile] = process.argv.slice(2);
if (!privateFile) throw new Error("usage: startup-pipe-filler-spawn <private-file>");

function openFds(): number[] {
	return readdirSync("/dev/fd")
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
}

function parentEnd(stream: unknown): number | undefined {
	const handle: unknown = typeof stream === "object" && stream !== null ? Reflect.get(stream, "_handle") : undefined;
	const fd: unknown = typeof handle === "object" && handle !== null ? Reflect.get(handle, "fd") : undefined;
	return typeof fd === "number" ? fd : undefined;
}

function collect(child: ChildProcess, slot: number): Promise<string> {
	return new Promise((resolveRead) => {
		let text = "";
		const stream: unknown = (child.stdio as readonly unknown[])[slot];
		if (!(stream instanceof Readable)) return resolveRead("");
		stream.on("data", (chunk: Buffer) => {
			text += String(chunk);
		});
		stream.on("close", () => resolveRead(text));
	});
}

const opened: number[] = [];
let privateFd: number | undefined;
for (let attempt = 0; attempt < 64 && privateFd === undefined; attempt += 1) {
	const fd = openSync(privateFile, "w");
	if (fd >= 5 && fd < STARTUP_EVENT_FD) privateFd = fd;
	else opened.push(fd);
}
// Node on Linux already holds every descriptor from 3 to 17 for its own event loop and worker platform, so no
// slot below the pipe can be free there: the spawn then carries no private descriptor and the report says so.
for (const fd of opened) closeSync(fd);

const control = spawn(process.execPath, [childScript], { stdio: ["ignore", "pipe", "inherit"] });
const controlReport = await collect(control, 1);

const { stdio, fillers } = withStartupPipe<"ignore" | "pipe" | "inherit">(["ignore", "pipe", "inherit"]);
const handOff = encodeStartupHandOff({
	binding: {
		attempt: "f".repeat(32),
		endpoint: "/fixture.sock",
		instanceId: "fixture",
		generation: 0,
		launchKind: "initial",
		predecessor: null,
	},
	role: "supervisor",
	budgetMs: 180_000,
	fillers,
});
const transfer = preparePrivateFdSpawn(
	{ stdio, env: { ...process.env, SENPI_RPC_HOST_STARTUP_EVENTS: handOff } },
	{ final: true },
	privateFd === undefined
		? { kind: "entries", entries: new Map() }
		: { kind: "entries", entries: new Map([["fixture", privateFd]]) },
);
const before = openFds();
const childArgs = privateFd === undefined ? [childScript] : [childScript, String(privateFd)];
const child = spawn(process.execPath, childArgs, transfer.options);
releaseStartupFillers(child, fillers);
transfer.close();
await new Promise<void>((resolveTick) => setImmediate(resolveTick));
const after = openFds();
const intendedParentEnds = [1, STARTUP_EVENT_FD].map((slot) => parentEnd((child.stdio as readonly unknown[])[slot]));
const [childReport, startup] = await Promise.all([collect(child, 1), collect(child, STARTUP_EVENT_FD)]);
const code = await new Promise<number | null>((resolveExit) =>
	child.exitCode !== null ? resolveExit(child.exitCode) : child.once("exit", resolveExit),
);
process.stdout.write(
	`${JSON.stringify({
		code,
		privateFd: privateFd ?? null,
		privateSlot: privateFd === undefined ? null : (transfer.options.stdio as readonly unknown[])[privateFd],
		fillers,
		before,
		after,
		intendedParentEnds,
		child: JSON.parse(childReport).fds,
		control: JSON.parse(controlReport).fds,
		startup,
		privateWrote: privateFd === undefined ? null : readFileSync(privateFile, "utf8"),
	})}\n`,
);
