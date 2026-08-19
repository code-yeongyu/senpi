import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAppServerCliArgs } from "../../src/modes/app-server/index.ts";

describe("app-server CLI subcommand parsing", () => {
	it("defaults listen to stdio when omitted", () => {
		// Given: the app-server subcommand has no listen flag.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs([]);

		// Then: the direct server command uses the stdio transport.
		expect(result).toEqual({
			kind: "server",
			listen: { kind: "stdio", url: "stdio://" },
			wsAuth: undefined,
			jsonLogs: false,
			configOverrides: [],
		});
	});

	it("parses ws listen host and port", () => {
		// Given: a loopback websocket listen URL.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(["--listen", "ws://127.0.0.1:18991"]);

		// Then: host and port are preserved as typed fields.
		expect(result).toEqual({
			kind: "server",
			listen: { kind: "ws", url: "ws://127.0.0.1:18991", host: "127.0.0.1", port: 18991 },
			wsAuth: undefined,
			jsonLogs: false,
			configOverrides: [],
		});
	});

	it("parses unix listen path override", () => {
		// Given: an absolute unix socket listen URL.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(["--listen", "unix:///tmp/senpi-app.sock"]);

		// Then: the absolute socket path is exposed.
		expect(result).toEqual({
			kind: "server",
			listen: { kind: "unix", url: "unix:///tmp/senpi-app.sock", path: "/tmp/senpi-app.sock" },
			wsAuth: undefined,
			jsonLogs: false,
			configOverrides: [],
		});
	});

	it("accepts one config override", () => {
		// Given: one Codex-style key/value override.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(["-c", "key=value"]);

		// Then: the raw key and value are exposed.
		expect(result).toEqual({
			kind: "server",
			listen: { kind: "stdio", url: "stdio://" },
			wsAuth: undefined,
			jsonLogs: false,
			configOverrides: [{ key: "key", value: "value" }],
		});
	});

	it("accumulates config overrides in order and preserves quoted values", () => {
		// Given: repeated Codex-style overrides, including a literal quoted value.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs([
			"-c",
			"first=one",
			"-c",
			'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
		]);

		// Then: overrides retain argv order and raw value text.
		expect(result).toMatchObject({
			kind: "server",
			configOverrides: [
				{ key: "first", value: "one" },
				{ key: "mcp_servers.t3-code.bearer_token_env_var", value: '"T3_MCP_BEARER_TOKEN"' },
			],
		});
	});

	it.each([
		["missing value", ["-c"], "-c requires <key>=<value>."],
		["missing equals", ["-c", "key"], "-c requires <key>=<value>."],
		["unknown argument", ["--bogus"], "Unexpected app-server argument: --bogus"],
	] as const)("returns a usage error for %s", (_name, args, message) => {
		// Given: malformed or unknown app-server arguments.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(args);

		// Then: parsing returns the specific usage error.
		expect(result).toEqual({ kind: "usage-error", message });
	});

	it("returns a usage error for invalid listen URLs", () => {
		// Given: an unsupported listen scheme.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(["--listen", "bogus://x"]);

		// Then: parsing returns a usage error object.
		expect(result).toEqual({
			kind: "usage-error",
			message: "Invalid --listen value. Use stdio://, unix://, unix:///abs/path, or ws://IP:PORT.",
		});
	});

	it("parses daemon verbs with listen options", () => {
		// Given: a daemon start command with a websocket listen URL.
		// When: the subcommand args are parsed.
		const result = parseAppServerCliArgs(["daemon", "start", "--listen", "ws://127.0.0.1:18991"]);

		// Then: the daemon verb and transport are returned together.
		expect(result).toEqual({
			kind: "daemon",
			verb: "start",
			listen: { kind: "ws", url: "ws://127.0.0.1:18991", host: "127.0.0.1", port: 18991 },
		});
	});

	it("does not embed the protected live daemon port literal in the QA runner", async () => {
		// Given: the app-server QA aggregate runner source.
		const source = await readFile(join(process.cwd(), "scripts/qa-app-server/run-all.mjs"), "utf8");

		// When: the source is scanned for the protected private daemon port.
		const containsProtectedPortLiteral = source.includes("18789");

		// Then: the runner preserves safety without carrying the literal.
		expect(containsProtectedPortLiteral).toBe(false);
	});
});
