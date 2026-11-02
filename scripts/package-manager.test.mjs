#!/usr/bin/env node
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import * as packageManager from "./package-manager.mjs";
import {
	cleanEnv,
	detectPackageManager,
	packageManagerInvocation,
	runScriptArguments,
	SUPPORTED_PACKAGE_MANAGERS,
} from "./package-manager.mjs";

describe("package-manager", () => {
	it("detects the invoking package manager from the user agent, then the execpath basename", () => {
		assert.deepEqual(detectPackageManager({ npm_execpath: "/Users/dev/.bun/bin/bun" }), {
			cmd: "bun",
			execpath: "/Users/dev/.bun/bin/bun",
		});
		assert.deepEqual(detectPackageManager({ npm_config_user_agent: "bun/1.4.0 npm/? node/v26.3.0" }), {
			cmd: "bun",
			execpath: undefined,
		});
		assert.deepEqual(detectPackageManager({ npm_execpath: "/usr/lib/node_modules/pnpm/bin/pnpm.cjs" }), {
			cmd: "pnpm",
			execpath: "/usr/lib/node_modules/pnpm/bin/pnpm.cjs",
		});
		assert.deepEqual(detectPackageManager({ npm_execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js" }), {
			cmd: "npm",
			execpath: "/usr/lib/node_modules/npm/bin/npm-cli.js",
		});
		// pnpm installed through `bun install -g` lives under ~/.bun/bin: the path contains "bun", the manager is pnpm.
		assert.deepEqual(
			detectPackageManager({
				npm_execpath: "/Users/dev/.bun/bin/pnpm",
				npm_config_user_agent: "pnpm/10.32.1 npm/? node/v26.7.0 darwin arm64",
			}),
			{ cmd: "pnpm", execpath: "/Users/dev/.bun/bin/pnpm" },
		);
		assert.deepEqual(detectPackageManager({ npm_execpath: "/Users/dev/.bun/bin/pnpm" }), {
			cmd: "pnpm",
			execpath: "/Users/dev/.bun/bin/pnpm",
		});
		assert.deepEqual(detectPackageManager({}), { cmd: "npm", execpath: undefined });
		assert.deepEqual(detectPackageManager({ npm_execpath: "/x/bun" }, "pnpm"), { cmd: "pnpm", execpath: undefined });
		assert.deepEqual(SUPPORTED_PACKAGE_MANAGERS, ["npm", "bun", "pnpm"]);
	});

	it("runs JS entry points through the current node and native binaries directly", () => {
		assert.deepEqual(packageManagerInvocation({ cmd: "bun", execpath: "/x/bun" }, ["run", "test"]), {
			command: "/x/bun",
			args: ["run", "test"],
		});
		assert.deepEqual(packageManagerInvocation({ cmd: "npm", execpath: "/x/npm-cli.js" }, ["run", "test"]), {
			command: process.execPath,
			args: ["/x/npm-cli.js", "run", "test"],
		});
		assert.deepEqual(packageManagerInvocation({ cmd: "pnpm", execpath: "C:/pnpm/pnpm.exe" }, ["run", "test"]), {
			command: "C:/pnpm/pnpm.exe",
			args: ["run", "test"],
		});
		assert.deepEqual(packageManagerInvocation({ cmd: "npm", execpath: undefined }, ["run", "test"]), {
			command: "npm",
			args: ["run", "test"],
		});
	});

	it("shapes forwarded script arguments per package manager", () => {
		// npm and bun consume the first "--"; pnpm forwards every token after the script name verbatim.
		assert.deepEqual(runScriptArguments({ cmd: "npm" }, "test", ["--grep", "x"]), ["run", "test", "--", "--grep", "x"]);
		assert.deepEqual(runScriptArguments({ cmd: "bun" }, "test", ["--grep", "x"]), ["run", "test", "--", "--grep", "x"]);
		assert.deepEqual(runScriptArguments({ cmd: "pnpm" }, "test", ["--grep", "x"]), ["run", "test", "--grep", "x"]);
		assert.deepEqual(runScriptArguments({ cmd: "pnpm" }, "test", []), ["run", "test"]);
	});

	// signalGroup takes its process primitives as parameters so BOTH platform
	// branches run on every runner: CI executes scripts tests on ubuntu only and
	// Windows delivers no catchable SIGTERM, so without injection the taskkill
	// branch would never execute under test anywhere.
	function recordingPrimitives(platform, { killError } = {}) {
		const calls = { kill: [], spawnSync: [] };
		const primitives = {
			platform,
			kill: (pid, signal) => {
				calls.kill.push([pid, signal]);
				if (killError) throw killError;
			},
			spawnSync: (command, args) => {
				calls.spawnSync.push([command, args]);
				return { status: 0 };
			},
		};
		return { calls, primitives };
	}

	it("signals the whole process group on POSIX and never shells out", () => {
		const { calls, primitives } = recordingPrimitives("linux");

		packageManager.signalGroup({ pid: 4242 }, "SIGTERM", primitives);

		assert.deepEqual(calls.kill, [[-4242, "SIGTERM"]]);
		assert.deepEqual(calls.spawnSync, []);
	});

	it("returns from Ctrl-C without synchronously listing Windows processes", async () => {
		const synchronous = [];
		let finishListing;
		const pending = packageManager.signalGroup({ pid: 4242 }, "SIGINT", {
			platform: "win32",
			spawnSync: (command, args) => {
				synchronous.push([command, args]);
				return { status: 1 };
			},
			execFile: (_command, _args, options, callback) => {
				assert.equal(options.timeout, 1_000);
				finishListing = callback;
			},
		});
		assert.deepEqual(synchronous, [], "Ctrl-C must return before a full process listing or taskkill");
		assert.equal(typeof finishListing, "function");
		finishListing(null, "4242 1 200 bun.exe\n4243 4242 210 node.exe\n4244 4243 100 unrelated.exe\n");
		await pending;
		assert.deepEqual(synchronous, [["taskkill", ["/F", "/PID", "4242", "/PID", "4243"]]]);
	});

	it("starts all fanout probes before draining them and re-raising Ctrl-C", async () => {
		const signals = new EventEmitter();
		const completions = [];
		const fanout = packageManager.createSignalFanout({
			signals,
			forward: () => new Promise((resolve) => completions.push(resolve)),
		});
		fanout.attach({ pid: 4242 });
		fanout.attach({ pid: 4243 });
		signals.emit("SIGINT");
		assert.equal(completions.length, 2);
		let released = false;
		const draining = fanout.release().then((signal) => {
			released = true;
			return signal;
		});
		await Promise.resolve();
		assert.equal(released, false);
		for (const complete of completions) complete();
		assert.equal(await draining, "SIGINT");
		assert.equal(signals.listenerCount("SIGINT"), 0);
	});

	it("falls back to the root only when an asynchronous Windows listing fails", async () => {
		for (const failure of ["callback", "throw"]) {
			const { calls, primitives } = recordingPrimitives("win32");
			primitives.execFile = (_command, _args, _options, callback) => {
				const error = new Error("listing unavailable");
				if (failure === "throw") throw error;
				callback(error);
			};
			await packageManager.signalGroup({ pid: 4242 }, "SIGINT", primitives);
			assert.deepEqual(calls.spawnSync, [["taskkill", ["/F", "/PID", "4242"]]]);
		}
	});

	it("terminates the process tree through taskkill on win32 and never sends a POSIX signal", async () => {
		const { calls, primitives } = recordingPrimitives("win32");
		primitives.execFile = (_command, _args, _options, callback) => {
			callback(
				null,
				"4242 1 200 bun.exe\n4243 4242 210 node.exe\n4244 4243 100 unrelated.exe\n4245 4243 220 child.exe\n",
			);
		};

		await packageManager.signalGroup({ pid: 4242 }, "SIGTERM", primitives);

		assert.deepEqual(calls.spawnSync, [["taskkill", ["/F", "/PID", "4242", "/PID", "4243", "/PID", "4245"]]]);
		assert.deepEqual(calls.kill, []);
	});

	it("treats a group that is already gone as success and does nothing without a pid", () => {
		const gone = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		const { calls, primitives } = recordingPrimitives("darwin", { killError: gone });

		assert.doesNotThrow(() => packageManager.signalGroup({ pid: 7 }, "SIGINT", primitives));
		assert.equal(calls.kill.length, 1, "the signal was attempted exactly once before the error was swallowed");

		const idle = recordingPrimitives("linux");
		packageManager.signalGroup({ pid: undefined }, "SIGTERM", idle.primitives);
		assert.deepEqual(idle.calls, { kill: [], spawnSync: [] });
	});

	it("strips pnpm-only npm_config keys without touching the rest of the environment", () => {
		const env = cleanEnv({
			npm_config_node_linker: "hoisted",
			NPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
			npm_config_user_agent: "pnpm/10.0.0",
			PATH: "/bin",
		});
		assert.deepEqual(env, { npm_config_user_agent: "pnpm/10.0.0", PATH: "/bin" });
	});
});
