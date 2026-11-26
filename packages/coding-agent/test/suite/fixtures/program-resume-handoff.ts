// senpi#7493 fixture: starts like the CLI (the hand-off is its first import), then reports what this process and the
// children it starts can see of OSC7577_TOKEN. A child started without an env gets Bun's startup environment.
import "../../../src/program-resume-startup.ts";

interface BunSpawner {
	spawn(cmd: string[], options: { stdout: "pipe" }): { stdout: ReadableStream<Uint8Array> };
	spawnSync(cmd: string[]): { stdout: { toString(): string } };
}
const bun = (globalThis as { Bun?: BunSpawner }).Bun;
if (bun === undefined) throw new Error("this fixture runs under Bun");
const read = async (stream: ReadableStream<Uint8Array>) => (await new Response(stream).text()).trim();
const probe = ["sh", "-c", "printenv OSC7577_TOKEN || printf unset"];

const spawnChild = await read(bun.spawn(probe, { stdout: "pipe" }).stdout);
const spawnSyncChild = bun.spawnSync(probe).stdout.toString().trim();
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

console.log(
	JSON.stringify({
		pid: process.pid,
		token: process.env.OSC7577_TOKEN ?? null,
		spawnChild,
		spawnSyncChild,
		workerEnv: workerView.env,
		workerChild: workerView.child,
	}),
);
