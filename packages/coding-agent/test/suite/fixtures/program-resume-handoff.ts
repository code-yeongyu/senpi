import "../../../src/program-resume-startup.ts";
import { fstatSync } from "node:fs";

interface BunSpawner {
	spawn(cmd: string[], options: { stdout: "pipe" }): { stdout: ReadableStream<Uint8Array> };
	spawnSync(cmd: string[]): { stdout: { toString(): string } };
}
const bun = (globalThis as { Bun?: BunSpawner }).Bun;
if (bun === undefined) throw new Error("this fixture runs under Bun");
const read = async (stream: ReadableStream<Uint8Array>) => (await new Response(stream).text()).trim();
const probe = ["sh", "-c", "printenv OSC7577_TOKEN || printf unset"];
const handoffNames = ["sh", "-c", "env | cut -d= -f1 | grep OSC7577 || printf none"];

const spawnChild = await read(bun.spawn(probe, { stdout: "pipe" }).stdout);
const spawnSyncChild = bun.spawnSync(probe).stdout.toString().trim();
const childEnvNames = bun.spawnSync(handoffNames).stdout.toString().trim();
const worker = new Worker(
	URL.createObjectURL(
		new Blob([
			`const p = Bun.spawn(${JSON.stringify(probe)}, { stdout: "pipe" });
			postMessage({ env: process.env.OSC7577_TOKEN ?? "unset", child: (await new Response(p.stdout).text()).trim() });`,
		]),
	),
);
const workerView = await new Promise<{ env: string; child: string }>((resolve) => {
	worker.onmessage = (event: MessageEvent<{ env: string; child: string }>) => resolve(event.data);
});
worker.terminate();
const inodeOf = (fd: number) => {
	try {
		return fstatSync(fd).ino;
	} catch {
		return null;
	}
};

console.log(
	JSON.stringify({
		pid: process.pid,
		cwd: process.cwd(),
		argv: process.argv.slice(2),
		token: process.env.OSC7577_TOKEN ?? null,
		spawnChild,
		spawnSyncChild,
		childEnvNames,
		workerEnv: workerView.env,
		workerChild: workerView.child,
		fd7Inode: inodeOf(7),
	}),
);
