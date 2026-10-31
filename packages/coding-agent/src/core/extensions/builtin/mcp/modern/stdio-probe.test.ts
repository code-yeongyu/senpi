import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { McpLogger } from "../log.ts";
import { probeStdioTransport } from "./stdio-probe.ts";
import { MODERN_PROTOCOL_VERSION } from "./wire.ts";

const options = {
	clientInfo: { name: "test", version: "1" },
	clientCapabilities: {},
	supportedVersions: [MODERN_PROTOCOL_VERSION],
};
function logger(): McpLogger {
	return {
		filePath: "",
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		stderr: vi.fn(),
		log: vi.fn(),
		getRingBuffer: () => [],
	};
}

type FakeChild = Transport & { readonly pid: number | null };

/** A legacy server whose first process misbehaves on discover; every later process is a well-behaved legacy server. */
function restartableLegacy(misbehave: (child: FakeChild, kill: () => void) => void) {
	const sent: { generation: number; method: string }[] = [];
	let generation = 0;
	let alive = false;
	const kill = () => {
		alive = false;
		queueMicrotask(() => child.onclose?.());
	};
	const child: FakeChild = {
		// Never a real process: the restart reaps this pid's tree.
		get pid() {
			return alive ? 2_147_483_000 + generation : null;
		},
		start: vi.fn(async () => {
			generation++;
			alive = true;
		}),
		close: vi.fn(async () => {
			if (!alive) return;
			alive = false;
			child.onclose?.();
		}),
		send: async (message) => {
			if (!alive) throw new Error("Not connected");
			const method = "method" in message ? message.method : "";
			sent.push({ generation, method });
			if (!("method" in message) || !("id" in message)) return;
			if (message.method === "server/discover" && generation === 1) return misbehave(child, kill);
			if (message.method === "server/discover") throw new Error("a fresh process must not be probed again");
			child.onmessage?.(
				message.method === "initialize"
					? {
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: message.params?.protocolVersion,
								capabilities: { tools: {} },
								serverInfo: { name: "legacy", version: "1" },
							},
						}
					: { jsonrpc: "2.0", id: message.id, result: { tools: [] } },
			);
		},
	};
	return { child, sent };
}

describe("stdio legacy fallback after an unclean probe", () => {
	it.each([
		["exits on discover", (_child: FakeChild, kill: () => void) => kill()],
		[
			"prints junk on stdout instead of answering",
			(child: FakeChild) =>
				child.onerror?.(new SyntaxError("Unexpected token 'S', \"Starting...\" is not valid JSON")),
		],
	])("connects a legacy server that %s on a fresh process", async (_name, misbehave) => {
		const { child, sent } = restartableLegacy(misbehave);
		const start = child.start;
		probeStdioTransport(child, options, logger(), 2000, "fixture", undefined, 50);
		const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
		const closed = vi.fn();
		client.onclose = closed;
		try {
			await client.connect(child);
			expect((await client.listTools()).tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(2);
			expect(sent).toEqual([
				{ generation: 1, method: "server/discover" },
				{ generation: 2, method: "initialize" },
				{ generation: 2, method: "notifications/initialized" },
				{ generation: 2, method: "tools/list" },
			]);
			expect(closed).not.toHaveBeenCalled();
		} finally {
			await client.close();
		}
	});
});

type SlowEra = "legacy" | "legacy-exit-on-discover" | "dual" | "modern" | "modern-32601";

/**
 * A server that reads nothing until the SDK's initialize arrives, which only happens after the probe window
 * closed: a deterministic slow start with no timers. Its first process then answers its backlog in order.
 * "legacy-exit-on-discover" dies on the backlogged discover; every later process is a plain legacy server.
 */
function slowServer(era: SlowEra) {
	const sent: { generation: number; method: string }[] = [];
	let generation = 0;
	let alive = false;
	let ready = false;
	const backlog: JSONRPCMessage[] = [];
	const child: Transport & { readonly pid: number | null } = {
		get pid() {
			return alive ? 2_147_483_100 + generation : null;
		},
		start: vi.fn(async () => {
			generation++;
			alive = true;
			ready = generation > 1;
		}),
		close: async () => {
			if (!alive) return;
			alive = false;
			child.onclose?.();
		},
		send: async (message) => {
			if (!alive) throw new Error("Not connected");
			if (ready) return handle(message);
			backlog.push(message);
			if ("method" in message && message.method === "initialize") {
				ready = true;
				for (const queued of backlog.splice(0)) if (alive) handle(queued);
			}
		},
	};
	const reply = (message: JSONRPCMessage) => queueMicrotask(() => child.onmessage?.(message));
	/** The child process exits on its own. */
	const kill = () => {
		alive = false;
		backlog.length = 0;
		queueMicrotask(() => child.onclose?.());
	};
	function handle(message: JSONRPCMessage): void {
		const legacyEra = generation > 1 || era === "legacy" || era === "legacy-exit-on-discover" || era === "dual";
		sent.push({ generation, method: "method" in message ? message.method : "" });
		if (!("method" in message) || !("id" in message)) return;
		const meta = message.params?._meta as Record<string, unknown> | undefined;
		const modernRequest = meta?.["io.modelcontextprotocol/protocolVersion"] === MODERN_PROTOCOL_VERSION;
		if (message.method === "server/discover") {
			if (era === "legacy-exit-on-discover" && generation === 1) {
				alive = false;
				queueMicrotask(() => child.onclose?.());
				return;
			}
			if (era === "legacy" || era === "legacy-exit-on-discover") {
				reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
				return;
			}
			reply({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					resultType: "complete",
					supportedVersions: [MODERN_PROTOCOL_VERSION],
					capabilities: { tools: {} },
					_meta: { "io.modelcontextprotocol/serverInfo": { name: `slow-${era}`, version: "1" } },
				},
			});
			return;
		}
		if (message.method === "initialize") {
			if (era === "modern" || era === "modern-32601") {
				const code = era === "modern" ? -32020 : -32601;
				reply({ jsonrpc: "2.0", id: message.id, error: { code, message: "initialize is not supported" } });
				return;
			}
			reply({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: message.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: `slow-${era}`, version: "1" },
				},
			});
			return;
		}
		if (!legacyEra && !modernRequest) {
			reply({ jsonrpc: "2.0", id: message.id, error: { code: -32020, message: "missing _meta" } });
			return;
		}
		reply({ jsonrpc: "2.0", id: message.id, result: { tools: [], nextCursor: undefined } });
	}
	return { child, sent, kill };
}

async function connectSlow(era: SlowEra) {
	const { child, sent } = slowServer(era);
	const start = child.start;
	const negotiated = vi.fn();
	probeStdioTransport(child, options, logger(), 2000, "fixture", negotiated, 1);
	const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
	await client.connect(child);
	const tools = (await client.listTools()).tools;
	return { client, start, sent, negotiated, tools };
}

describe("stdio servers that are slow to start", () => {
	it("connects a slow legacy server on its first process", async () => {
		const { client, start, sent, negotiated, tools } = await connectSlow("legacy");
		try {
			expect(client.getServerVersion()?.name).toBe("slow-legacy");
			expect(tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(1);
			expect(negotiated).not.toHaveBeenCalled();
			expect(sent.map((entry) => entry.method)).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/list",
			]);
		} finally {
			await client.close();
		}
	});

	it("restarts a slow legacy server that exits on discover and replays initialize", async () => {
		const { client, start, sent, tools } = await connectSlow("legacy-exit-on-discover");
		try {
			expect(tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(2);
			expect(sent).toEqual([
				{ generation: 1, method: "server/discover" },
				{ generation: 2, method: "initialize" },
				{ generation: 2, method: "notifications/initialized" },
				{ generation: 2, method: "tools/list" },
			]);
		} finally {
			await client.close();
		}
	});

	it("waits for the fresh process when the child dies before the SDK sends initialize, and sends it once", async () => {
		const { child, sent, kill } = slowServer("legacy");
		const start = child.start;
		probeStdioTransport(child, options, logger(), 2000, "fixture", undefined, 1);
		// The first process dies the moment the probe window closes, before the SDK's initialize goes out.
		const probed = child.start;
		let killed = false;
		child.start = async () => {
			await probed();
			if (!killed) {
				killed = true;
				kill();
			}
		};
		const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
		try {
			await client.connect(child);
			expect((await client.listTools()).tools).toEqual([]);
			expect(sent.filter((entry) => entry.method === "initialize")).toHaveLength(1);
			expect(start).toHaveBeenCalledTimes(2);
		} finally {
			await client.close();
		}
	});

	it.each(["modern", "modern-32601"] as const)(
		"upgrades a slow %s server on its first process when its discovery answers late",
		async (era) => {
			const { client, start, sent, negotiated, tools } = await connectSlow(era);
			try {
				expect(client.getServerVersion()?.name).toBe(`slow-${era}`);
				expect(tools).toEqual([]);
				expect(start).toHaveBeenCalledTimes(1);
				expect(negotiated).toHaveBeenCalledWith(MODERN_PROTOCOL_VERSION);
				expect(sent.map((entry) => entry.method)).toEqual(["server/discover", "initialize", "tools/list"]);
			} finally {
				await client.close();
			}
		},
	);

	it("stays legacy for the connection's lifetime when a late discovery meets a successful initialize", async () => {
		const { client, start, sent, negotiated, tools } = await connectSlow("dual");
		try {
			expect(tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(1);
			expect(negotiated).not.toHaveBeenCalled();
			expect(sent.map((entry) => entry.method)).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/list",
			]);
		} finally {
			await client.close();
		}
	});
});

describe("stdio discovery ownership", () => {
	it("probes and initializes the same started legacy transport without changing initialize bytes", async () => {
		const sent: JSONRPCMessage[] = [];
		const inner: Transport = {
			start: vi.fn(async () => {}),
			close: async () => inner.onclose?.(),
			send: async (message) => {
				sent.push(message);
				if (!("method" in message) || !("id" in message)) return;
				if (message.method === "server/discover") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					});
				} else if (message.method === "initialize") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "legacy", version: "1" },
						},
					});
				} else {
					inner.onmessage?.({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
				}
			},
		};
		const start = inner.start;
		probeStdioTransport(inner, options, logger(), 2000, "fixture");
		const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
		try {
			await client.connect(inner);
			expect((await client.listTools()).tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(1);
			expect(sent.map((message) => ("method" in message ? message.method : ""))).toEqual([
				"server/discover",
				"initialize",
				"notifications/initialized",
				"tools/list",
			]);
			expect(sent[1]).toMatchObject({ id: 0, params: { capabilities: {}, clientInfo: options.clientInfo } });
			expect(sent[1]).not.toHaveProperty("params._meta");
		} finally {
			await client.close();
		}
	});

	it("speaks 2026-07-28 to a modern-only stdio server with no legacy handshake on the wire", async () => {
		const sent: JSONRPCMessage[] = [];
		const negotiated = vi.fn();
		const inner: Transport = {
			start: vi.fn(async () => {}),
			close: async () => inner.onclose?.(),
			send: async (message) => {
				sent.push(message);
				if (!("method" in message) || !("id" in message)) return;
				const meta = message.params?._meta as Record<string, unknown> | undefined;
				if (meta?.["io.modelcontextprotocol/protocolVersion"] !== MODERN_PROTOCOL_VERSION) {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32020, message: "missing per-request _meta" },
					});
				} else if (message.method === "server/discover") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						result: {
							resultType: "complete",
							supportedVersions: [MODERN_PROTOCOL_VERSION],
							capabilities: { tools: {} },
							_meta: { "io.modelcontextprotocol/serverInfo": { name: "modern-stdio", version: "1" } },
						},
					});
				} else if (message.method === "tools/list") {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						result: { resultType: "complete", tools: [], nextCursor: null },
					});
				} else {
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32601, message: "Method not found" },
					});
				}
			},
		};
		const start = inner.start;
		probeStdioTransport(inner, options, logger(), 2000, "fixture", negotiated);
		const client = new Client(options.clientInfo, { capabilities: options.clientCapabilities });
		try {
			await client.connect(inner);
			expect(client.getServerVersion()?.name).toBe("modern-stdio");
			expect((await client.listTools()).tools).toEqual([]);
			expect(start).toHaveBeenCalledTimes(1);
			expect(negotiated).toHaveBeenCalledWith(MODERN_PROTOCOL_VERSION);
			expect(sent.map((message) => ("method" in message ? message.method : ""))).toEqual([
				"server/discover",
				"tools/list",
			]);
			expect(sent[1]).toMatchObject({
				params: {
					_meta: {
						"io.modelcontextprotocol/protocolVersion": MODERN_PROTOCOL_VERSION,
						"io.modelcontextprotocol/clientInfo": options.clientInfo,
						"io.modelcontextprotocol/clientCapabilities": options.clientCapabilities,
					},
				},
			});
		} finally {
			await client.close();
		}
	});

	it("fails a modern stdio server whose discovery errors without sending initialize or restarting", async () => {
		const sent: JSONRPCMessage[] = [];
		const log = logger();
		const inner: Transport = {
			start: vi.fn(async () => {}),
			close: vi.fn(async () => inner.onclose?.()),
			send: async (message) => {
				sent.push(message);
				if ("id" in message)
					inner.onmessage?.({
						jsonrpc: "2.0",
						id: message.id,
						error: { code: -32020, message: "Modern" },
					});
			},
		};
		const start = inner.start;
		const close = inner.close;
		probeStdioTransport(inner, options, log, 2000, "fixture");
		const client = new Client(options.clientInfo);
		try {
			await expect(client.connect(inner)).rejects.toThrow(/MCP server fixture modern discovery failed: Modern/);
			expect(start).toHaveBeenCalledTimes(1);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ method: "server/discover" });
			expect(log.error).toHaveBeenCalledOnce();
		} finally {
			await client.close();
		}
		expect(close).toHaveBeenCalledOnce();
	});
});
