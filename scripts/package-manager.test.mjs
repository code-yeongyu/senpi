#!/usr/bin/env node
import assert from "node:assert/strict";
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

	it("terminates the process tree through taskkill on win32 and never sends a POSIX signal", () => {
		const { calls, primitives } = recordingPrimitives("win32");

		packageManager.signalGroup({ pid: 4242 }, "SIGTERM", primitives);

		assert.deepEqual(calls.spawnSync, [["taskkill", ["/pid", "4242", "/T", "/F"]]]);
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
