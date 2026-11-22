import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hostSpawnEnv } from "../helpers/rpc-host-spawn-env.ts";

function killIfAlive(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
	}
}

// senpi#3795: the recorded supervisor is separated from the engine by a spawning wrapper.
describe.skipIf(process.platform === "win32")("wrapped internal host lifetime", () => {
	it.each(["node", "bun"])(
		"%s keeps the host reachable through a wrapper and ends it on supervisor death",
		async (runtime) => {
			const root = mkdtempSync("/tmp/rpc-hop-life-");
			const endpoint = join(root, "control");
			const server = createServer();
			let child: ChildProcess | undefined;
			let control: Socket | undefined;
			let descendant: { pid: number; ppid: number } | undefined;
			try {
				const listening = once(server, "listening");
				server.listen(endpoint);
				await listening;
				const connected = once(server, "connection");
				child = spawn(
					runtime,
					[
						...(runtime === "bun" ? [] : ["--import", "tsx"]),
						join(import.meta.dirname, "rpc-internal-lifetime-harness.ts"),
						"supervisor",
						runtime,
						endpoint,
					],
					{
						env: { ...hostSpawnEnv() },
						stdio: ["ignore", "ignore", "pipe"],
					},
				);
				const connection = await Promise.race([
					connected,
					once(child, "exit").then(([code]) => {
						throw new Error(`supervisor exited ${code} before host connected`);
					}),
				]);
				control = connection[0];
				if (!control) throw new Error("no host control connection");
				descendant = JSON.parse(String((await once(control, "data"))[0]));
				expect(descendant?.ppid).not.toBe(child.pid);
				const response = once(control, "data");
				control.write("ping");
				expect(String((await response)[0])).toBe("alive");
				const closed = once(control, "close");
				const exited = once(child, "exit");
				child.kill("SIGKILL");
				await exited;
				await closed;
			} finally {
				if (child && child.exitCode === null && child.signalCode === null) {
					const exited = once(child, "exit");
					child.kill("SIGKILL");
					await exited;
				}
				for (const pid of descendant ? [descendant.pid, descendant.ppid] : []) killIfAlive(pid);
				control?.destroy();
				await new Promise<void>((resolve) => server.close(() => resolve()));
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});
