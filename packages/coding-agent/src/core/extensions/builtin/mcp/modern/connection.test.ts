import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "../config-schema.ts";
import { ServerConnection } from "../connection.ts";
import { createMcpLogger } from "../log.ts";

afterEach(() => vi.unstubAllGlobals());

async function connectionFixture(overrides: Partial<McpServerConfig> = {}) {
	const root = await mkdtemp(join(tmpdir(), "mcp-discovery-"));
	const connection = new ServerConnection({
		serverName: "fixture",
		logger: createMcpLogger("fixture", { logDir: root }),
		config: {
			type: "http",
			url: "https://fixture.test/mcp",
			args: [],
			enabled: true,
			exposure: "auto",
			lifecycle: "lazy",
			idleTimeoutMin: 10,
			connectTimeoutMs: 2000,
			requestTimeoutMs: 2000,
			startupTimeoutMs: 250,
			logLevel: "info",
			...overrides,
		},
	});
	return {
		connection,
		cleanup: async () => {
			await connection.dispose();
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("discovery connection ownership", () => {
	it("does not respawn detected modern stdio for legacy failure diagnostics", async () => {
		const root = await mkdtemp(join(tmpdir(), "mcp-stdio-"));
		const receipt = join(root, "requests");
		const script = `
			const fs = require("node:fs");
			const readline = require("node:readline");
			fs.appendFileSync(process.argv[1], "spawn\\n");
			async function main() {
				for await (const line of readline.createInterface({ input: process.stdin })) {
					const request = JSON.parse(line);
					fs.appendFileSync(process.argv[1], request.method + "\\n");
					process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id,
						error: { code: -32020, message: "modern only" } }) + "\\n");
				}
			}
			main().catch(error => { console.error(error); process.exitCode = 1; });
		`;
		const { connection, cleanup } = await connectionFixture({
			type: "stdio",
			command: process.execPath,
			args: ["-e", script, receipt],
		});
		try {
			await expect(connection.connect()).rejects.toMatchObject({ phase: "modern-stdio" });
			expect(await readFile(receipt, "utf8")).toBe("spawn\nserver/discover\n");
			expect(connection.state).toBe("degraded");
		} finally {
			await cleanup();
			await rm(root, { recursive: true, force: true });
		}
	});

	it("aborts pending discovery on dispose without opening a legacy connection", async () => {
		const entered = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const fetch = vi.fn(
			(_url: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							reject(init.signal?.reason);
						},
						{ once: true },
					);
					entered.resolve();
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const { connection, cleanup } = await connectionFixture();
		try {
			const pending = connection.connect();
			const rejected = expect(pending).rejects.toThrow(/superseded/);
			await entered.promise;
			await connection.dispose();
			await aborted.promise;
			await rejected;
			expect(fetch).toHaveBeenCalledOnce();
			expect(connection.state).toBe("disabled");
		} finally {
			await cleanup();
		}
	});

	it("publishes single flight before connecting listeners and diagnoses failed discovery", async () => {
		const fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			const request = JSON.parse(String(init?.body));
			return Response.json(
				{ jsonrpc: "2.0", id: request.id, error: { code: -32021, message: "Missing required capability" } },
				{ status: 400 },
			);
		});
		vi.stubGlobal("fetch", fetch);
		const { connection, cleanup } = await connectionFixture();
		const observed: Promise<unknown>[] = [];
		connection.onStateChange((event) => {
			if (event.state === "connecting") observed.push(connection.connect());
		});
		try {
			const pending = connection.connect();
			const rejected = expect(pending).rejects.toThrow(/modern discovery failed/);
			await rejected;
			expect(observed).toEqual([pending]);
			expect(fetch).toHaveBeenCalledOnce();
			expect(connection.state).toBe("degraded");
			expect(connection.lastError?.message).toContain("modern discovery failed");
		} finally {
			await cleanup();
		}
	});
});
