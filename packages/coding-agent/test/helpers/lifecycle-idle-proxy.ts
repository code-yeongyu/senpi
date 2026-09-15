import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHostClientProxy } from "../../src/modes/rpc/host-client-proxy.ts";
import { IdleExitDecider } from "../../src/modes/rpc/host-lifecycle.ts";
import { resolveSocketTransportAddress, sendSocketHandshake } from "../../src/modes/rpc/socket-transport.ts";

/** #1656: registered by the lifecycle entry so the Windows job executes the regression. */
export function registerIdleProxyTests(): void {
	describe("idle exit decision core", () => {
		function fakeClock(start: number): { now: () => number; advance: (ms: number) => void } {
			let current = start;
			return { now: () => current, advance: (ms: number) => (current += ms) };
		}

		it("exits only after the window elapsed with continuous idle", () => {
			const clock = fakeClock(1_000);
			const decider = new IdleExitDecider(600, clock.now);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
			clock.advance(599);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
			clock.advance(1);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
		});

		it("activity resets the window; a connection or turn holds the host open", () => {
			const clock = fakeClock(0);
			const decider = new IdleExitDecider(600, clock.now);
			decider.update({ connections: 0, activeTurns: 0 });
			clock.advance(500);
			expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
			clock.advance(60_000);
			expect(decider.update({ connections: 1, activeTurns: 0 })).toBe("active");
			expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
			clock.advance(60_000);
			expect(decider.update({ connections: 0, activeTurns: 2 })).toBe("active");
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
			clock.advance(599);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
			clock.advance(1);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("exit");
		});

		it("an infinite window (persistent cold start) never exits", () => {
			const clock = fakeClock(0);
			const decider = new IdleExitDecider(Number.POSITIVE_INFINITY, clock.now);
			decider.update({ connections: 0, activeTurns: 0 });
			clock.advance(Number.MAX_SAFE_INTEGER);
			expect(decider.update({ connections: 0, activeTurns: 0 })).toBe("idle");
		});
	});

	describe("supervisor activity between idle ticks", () => {
		it.each([
			{
				name: "accepts the next client when a readiness connection fits entirely between ticks",
				authorized: true,
				tickAt: 800,
				serves: true,
			},
			{
				name: "exits when the full idle window elapses after the readiness connection detaches",
				authorized: true,
				tickAt: 1_599,
				serves: false,
			},
			{
				name: "does not reset the idle window when authentication is rejected",
				authorized: false,
				tickAt: 800,
				serves: false,
			},
		])(
			"$name",
			async ({ authorized, tickAt, serves }) => {
				// Given: a real authenticated proxy, with only the idle clock controlled.
				await using root = await mkdtempDisposable(join(tmpdir(), "hlp-"));
				const internalSocket = join(root.path, "i.sock");
				const publicSocket = resolveSocketTransportAddress(join(root.path, "p.sock"), process.platform);
				const secret = randomBytes(32);
				let now = 0;
				const decider = new IdleExitDecider(800, () => now);
				const clients = new Set<Socket>();
				const sockets = new Set<Socket>();
				const currentActivity = () => ({ connections: clients.size, activeTurns: 0 });
				const activity = {
					clients,
					isShuttingDown: () => false,
					onActivity: () => decider.update(currentActivity()),
				};
				await using upstream = createServer((socket) => {
					sockets.add(socket);
					socket.pipe(socket);
				});
				await using proxy = createHostClientProxy(
					{ publicSecret: secret, internalSocket, internalSecret: undefined },
					activity,
				);
				const upstreamListening = once(upstream, "listening");
				upstream.listen(resolveSocketTransportAddress(internalSocket, process.platform));
				await upstreamListening;
				const proxyListening = once(proxy, "listening");
				proxy.listen(publicSocket);
				await proxyListening;
				try {
					decider.update(currentActivity());
					now = 790;
					const accepted = new Promise<Socket>((resolve) => proxy.once("connection", resolve));
					const probe = createConnection(publicSocket);
					sockets.add(probe);
					await once(probe, "connect", { signal: AbortSignal.timeout(5_000) });
					const detached = once(await accepted, "close", { signal: AbortSignal.timeout(5_000) });
					if (authorized) {
						const reply = once(probe, "data", { signal: AbortSignal.timeout(5_000) });
						sendSocketHandshake(probe, secret);
						probe.write("readiness");
						await reply;
						now = 799;
						probe.destroy();
					} else {
						sendSocketHandshake(
							probe,
							secret.map((byte) => byte ^ 0xff),
						);
					}
					await detached;

					// When: the next supervisor tick runs after that entire connection.
					now = tickAt;
					if (decider.update(currentActivity()) === "exit") {
						const closed = once(proxy, "close");
						proxy.close();
						await closed;
					}

					// Then: connectability reflects continuous idle time, not sampled activity.
					const client = createConnection(publicSocket);
					sockets.add(client);
					const connected = once(client, "connect", { signal: AbortSignal.timeout(5_000) });
					if (!serves) {
						await expect(connected).rejects.toMatchObject({ code: "ENOENT" });
						return;
					}
					await connected;
					const response = once(client, "data", { signal: AbortSignal.timeout(5_000) });
					sendSocketHandshake(client, secret);
					client.write("next-request");
					const [data] = await response;
					expect(data).toEqual(Buffer.from("next-request"));
				} finally {
					for (const socket of sockets) socket.destroy();
					for (const socket of clients) socket.destroy();
				}
			},
			15_000,
		);
	});
}
