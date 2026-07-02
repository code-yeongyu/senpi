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
		});
	});
});
