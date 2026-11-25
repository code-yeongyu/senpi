import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardInternalHop, INTERNAL_HOP_GUARD_INTERVAL_MS } from "../../src/modes/rpc/host-internal-hop-guard.ts";
import { listen } from "../../src/modes/rpc/host-socket-bind.ts";

// senpi#7452: a supervised host whose private hop entry disappears mid-life re-binds it or reports the loss.
describe.skipIf(process.platform === "win32")("guardInternalHop", () => {
	const created: string[] = [];
	const servers: Server[] = [];
	const stops: Array<() => void> = [];

	afterEach(async () => {
		for (const stop of stops.splice(0)) stop();
		vi.useRealTimers();
		for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
		for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	async function servedHop() {
		const root = mkdtempSync(join("/tmp", "s7452g-"));
		created.push(root);
		const dir = join(root, "senpi-rpc-host-internal-7452g");
		mkdirSync(dir, { mode: 0o700 });
		const socketPath = join(dir, "host.sock");
		const bind = async () => {
			const server = createServer((socket) => socket.end("served\n"));
			servers.push(server);
			return listen(server, socketPath);
		};
		return { root, dir, socketPath, bind, identity: await bind() };
	}

	function readGreeting(socketPath: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const client = connect(socketPath);
			let text = "";
			client.setEncoding("utf8");
			client.on("data", (chunk: string) => {
				text += chunk;
			});
			client.once("end", () => resolve(text));
			client.once("error", reject);
		});
	}

	it("re-binds the same path, in a fresh private directory owned by the supervisor, after the directory is removed", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const hop = await servedHop();
		const owner = { pid: 4242, processStartTime: "Mon Jan  1 00:00:00 2001 UTC" };
		const outcome = Promise.withResolvers<string>();
		stops.push(
			guardInternalHop({
				socketPath: hop.socketPath,
				identity: hop.identity,
				owner,
				bind: hop.bind,
				onRebound: () => outcome.resolve("rebound"),
				onLost: (reason) => outcome.resolve(`lost: ${reason}`),
			}),
		);

		rmSync(hop.dir, { recursive: true, force: true });
		await vi.advanceTimersByTimeAsync(INTERNAL_HOP_GUARD_INTERVAL_MS);

		expect(await outcome.promise).toBe("rebound");
		expect(await readGreeting(hop.socketPath)).toBe("served\n");
		expect(statSync(hop.dir).mode & 0o777).toBe(0o700);
		expect(JSON.parse(readFileSync(join(hop.dir, ".owner"), "utf8"))).toMatchObject(owner);
	});

	it("reports the loss instead of staying silent when the hop cannot be re-bound", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const hop = await servedHop();
		const outcome = Promise.withResolvers<string>();
		stops.push(
			guardInternalHop({
				socketPath: hop.socketPath,
				identity: hop.identity,
				bind: hop.bind,
				onRebound: () => outcome.resolve("rebound"),
				onLost: (reason) => outcome.resolve(`lost: ${reason}`),
			}),
		);

		// The whole parent goes too, so the private directory cannot be recreated in place.
		rmSync(hop.root, { recursive: true, force: true });
		await vi.advanceTimersByTimeAsync(INTERNAL_HOP_GUARD_INTERVAL_MS);

		expect(await outcome.promise).toMatch(/^lost: /);
	});

	it("leaves a healthy hop alone", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
		const hop = await servedHop();
		const events: string[] = [];
		stops.push(
			guardInternalHop({
				socketPath: hop.socketPath,
				identity: hop.identity,
				bind: hop.bind,
				onRebound: () => events.push("rebound"),
				onLost: (reason) => events.push(`lost: ${reason}`),
			}),
		);

		await vi.advanceTimersByTimeAsync(INTERNAL_HOP_GUARD_INTERVAL_MS * 3);

		expect(events).toEqual([]);
		expect(servers).toHaveLength(1);
	});
});
