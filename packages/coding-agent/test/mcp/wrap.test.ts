import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AuthError,
	ConnectError,
	isRetriableMcpError,
	ProtocolError,
	TimeoutError,
	ToolExecError,
} from "../../src/core/extensions/builtin/mcp/errors.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "../..");
const mcpSourceRoot = path.join(packageRoot, "src/core/extensions/builtin/mcp");

describe("mcp error taxonomy", () => {
	it("exposes typed errors with stable kind and metadata", () => {
		const cases = [
			[new ConnectError("connect failed", { serverName: "srv", phase: "connect" }), "ConnectError", "connect"],
			[new ProtocolError("bad rpc"), "ProtocolError", "protocol"],
			[new ToolExecError("tool failed"), "ToolExecError", "tool_exec"],
			[new AuthError("auth failed"), "AuthError", "auth"],
			[new TimeoutError("timed out"), "TimeoutError", "timeout"],
		] as const;

		for (const [error, name, kind] of cases) {
			expect(error).toBeInstanceOf(Error);
			expect(error.name).toBe(name);
			expect(error.kind).toBe(kind);
		}

		expect(cases[0][0].serverName).toBe("srv");
		expect(cases[0][0].phase).toBe("connect");
	});

	it("classifies only known retriable MCP failures", () => {
		const retriableInputs: unknown[] = [
			new ConnectError("connect ECONNREFUSED 127.0.0.1"),
			Object.assign(new Error("dial failed"), { code: "ECONNREFUSED" }),
			new ProtocolError("Transport closed before response"),
			{ code: -32001 },
			{ status: 404 },
			{ statusCode: 502 },
			{ response: { status: 503 } },
			"transport closed by peer",
			"HTTP 502 Bad Gateway",
		];

		for (const input of retriableInputs) {
			expect(isRetriableMcpError(input), JSON.stringify(input)).toBe(true);
		}

		const nonRetriableInputs: unknown[] = [
			null,
			undefined,
			"",
			{ code: -32602 },
			{ status: 401 },
			{ response: { status: 500 } },
			new AuthError("401 needs login"),
			new ToolExecError("tool validation failed"),
		];

		for (const input of nonRetriableInputs) {
			expect(isRetriableMcpError(input), JSON.stringify(input)).toBe(false);
		}
	});
});

describe("mcp async source guard", () => {
	it("keeps raw timers and event emitter listeners centralized in wrap.ts", async () => {
		const offenders: string[] = [];
		for (const file of await collectSourceFiles(mcpSourceRoot)) {
			const relative = path.relative(mcpSourceRoot, file);
			if (relative === "wrap.ts") continue;
			const source = await readFile(file, "utf8");
			const lines = source.split("\n");
			lines.forEach((line, index) => {
				if (
					line.includes("setTimeout(") ||
					line.includes("setInterval(") ||
					(line.includes(".on(") && !line.includes("pi.on("))
				) {
					offenders.push(`${relative}:${index + 1}:${line.trim()}`);
				}
			});
		}

		expect(offenders).toEqual([]);
	});
});

async function collectSourceFiles(root: string): Promise<string[]> {
	const entries = await readdir(root, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const fullPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await collectSourceFiles(fullPath)));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(fullPath);
		}
	}
	return files;
}
