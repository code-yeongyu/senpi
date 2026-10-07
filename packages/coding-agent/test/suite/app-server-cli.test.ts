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
			extensions: [],
		});
	});

	it("collects repeated --extension paths for the server and every daemon verb", () => {
		// Given: extension paths before and after other server and daemon flags.
		// When: the subcommand args are parsed.
		const server = parseAppServerCliArgs([
			"--extension",
			"/p/plugin",
			"--listen",
			"stdio://",
			"--extension",
			"./x.ts",
		]);
		const daemon = parseAppServerCliArgs(["daemon", "restart", "--extension", "/p/plugin"]);
		const missing = parseAppServerCliArgs(["--extension"]);

		// Then: paths keep their order, and a dangling flag is a usage error.
		expect(server).toMatchObject({ kind: "server", extensions: ["/p/plugin", "./x.ts"] });
		expect(daemon).toMatchObject({ kind: "daemon", verb: "restart", extensions: ["/p/plugin"] });
		expect(missing).toEqual({ kind: "usage-error", message: "--extension requires <path>." });
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
			extensions: [],
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
			extensions: [],
		});
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
			extensions: [],
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
