import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkerBaseArgs } from "../src/cli/neo/daemon-launch.ts";
import * as config from "../src/config.ts";

describe("resolveWorkerBaseArgs dev fallback", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.SENPI_NEO_WORKER_ARGS;
	});

	it("honors SENPI_NEO_WORKER_ARGS override verbatim", () => {
		process.env.SENPI_NEO_WORKER_ARGS = JSON.stringify(["/x/rpc-entry.ts", "--foo"]);
		expect(resolveWorkerBaseArgs()).toEqual(["/x/rpc-entry.ts", "--foo"]);
	});

	it("uses dist/rpc-entry.js when it exists", () => {
		const dir = join(tmpdir(), `neo-wa-dist-${Date.now()}`);
		mkdirSync(join(dir, "dist"), { recursive: true });
		writeFileSync(join(dir, "dist", "rpc-entry.js"), "//built\n");
		vi.spyOn(config, "getPackageDir").mockReturnValue(dir);
		expect(resolveWorkerBaseArgs()).toEqual([join(dir, "dist", "rpc-entry.js")]);
		rmSync(dir, { recursive: true, force: true });
	});

	it("falls back to src/rpc-entry.ts when dist/rpc-entry.js is absent (dev checkout)", () => {
		const dir = join(tmpdir(), `neo-wa-src-${Date.now()}`);
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "rpc-entry.ts"), "//src\n");
		expect(existsSync(join(dir, "dist", "rpc-entry.js"))).toBe(false);
		vi.spyOn(config, "getPackageDir").mockReturnValue(dir);
		expect(resolveWorkerBaseArgs()).toEqual([join(dir, "src", "rpc-entry.ts")]);
		rmSync(dir, { recursive: true, force: true });
	});
});
