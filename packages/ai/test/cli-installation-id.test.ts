import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { LoginOptions } from "../src/auth/types.ts";

const fixture = vi.hoisted(() => ({
	home: "",
	deviceIds: [] as string[],
	onSaved: () => {},
}));

vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
			fs.writeFileSync(...args);
			if (args[0] === "auth.json") fixture.onSaved();
		},
	};
});
vi.mock("node:os", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:os")>()),
	homedir: () => fixture.home,
}));
vi.mock("../src/providers/all.ts", () => ({
	builtinProviders: () => [
		{
			id: "fixture",
			name: "Fixture",
			auth: {
				oauth: {
					login: async (_interaction: unknown, options: LoginOptions) => {
						if (!options.getDeviceId) throw new Error("login options lack getDeviceId");
						fixture.deviceIds.push(options.getDeviceId());
						return { type: "oauth", access: "synthetic", refresh: "synthetic", expires: 0 };
					},
				},
			},
		},
	],
}));

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
	if (fixture.home) rmSync(fixture.home, { recursive: true, force: true });
	fixture.home = "";
	fixture.deviceIds = [];
	fixture.onSaved = () => {};
});

// senpi#5003: exercise CLI bootstrap twice, not a persistence helper in isolation.
it("reuses its persisted installation ID after the CLI restarts", async () => {
	fixture.home = mkdtempSync(join(tmpdir(), "ai-cli-host-"));
	const argv = process.argv;
	process.argv = ["bun", "cli.ts", "login", "fixture"];
	const cwd = process.cwd();
	process.chdir(fixture.home);
	const otherProject = join(fixture.home, "other-project");
	mkdirSync(otherProject);
	vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		for (let run = 0; run < 2; run++) {
			process.chdir(run === 0 ? fixture.home : otherProject);
			const finished = new Promise<void>((resolve) => {
				fixture.onSaved = resolve;
			});
			vi.resetModules();
			await import("../src/cli.ts");
			await finished;
		}
		expect(fixture.deviceIds[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(fixture.deviceIds[1]).toBe(fixture.deviceIds[0]);
	} finally {
		process.chdir(cwd);
		process.argv = argv;
	}
});
