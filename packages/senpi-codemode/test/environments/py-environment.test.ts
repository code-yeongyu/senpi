import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installPythonPackages } from "../../src/environments/py-environment.ts";
import { parsePipRequirements } from "../../src/environments/py-installer.ts";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { buildWheel, fixtureDir, hasPythonWithPip, importFrom, siteFilesSnapshot } from "./wheel-fixtures.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; base: string; wheels: string }> {
	const root = await mkdtemp(join(tmpdir(), "senpi-env-"));
	roots.push(root);
	const wheels = fixtureDir(root);
	await mkdir(wheels, { recursive: true });
	return { root, base: join(root, "environments", "py", "abi"), wheels };
}

function install(base: string, root: string, requirements: string, signal = new AbortController().signal) {
	return installPythonPackages({ base, mode: "managed", interpreter: "python3", requirements, cwd: root, signal });
}

describe.skipIf(!hasPythonWithPip())("Given a Python environment root", () => {
	it("When a local wheel installs, then it is published as the active revision and imports from it", async () => {
		const { root, base, wheels } = await workspace();
		const wheel = buildWheel(wheels, "senpi_probe", "1.0");

		const receipt = await install(base, root, `install --no-index ${wheel}`);

		expect(receipt).toMatchObject({ manager: "pip", revision: 1, changed: true, resolved: ["senpi-probe-1.0"] });
		expect((await readActiveRevision(base))?.number).toBe(1);
		expect(importFrom(receipt.root, "senpi_probe")).toBe("1.0");
	});

	it("When a later install fails, then the previous revision stays active and importable and nothing partial is left", async () => {
		const { root, base, wheels } = await workspace();
		const first = await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);
		const broken = buildWheel(wheels, "senpi_broken", "1.0", ["senpi-nonexistent-dependency"]);

		const failure = install(base, root, `install --no-index ${broken}`);

		await expect(failure).rejects.toMatchObject({ code: "environment_install_failed" });
		await expect(failure).rejects.toThrow(/No matching distribution/);
		expect(await readActiveRevision(base)).toEqual({ number: 1, dir: first.root });
		expect(importFrom(first.root, "senpi_probe")).toBe("1.0");
		expect((await readdir(base)).filter((name) => name !== "active").sort()).toEqual(["rev-1"]);
	});

	it("When an install is interrupted while pip is working, then pip is stopped promptly and the previous revision stays active", async () => {
		const { root, base, wheels } = await workspace();
		const first = await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);
		const controller = new AbortController();
		let abortedAt = 0;
		const server = createServer(() => {
			abortedAt = performance.now();
			controller.abort();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;

		const pending = install(
			base,
			root,
			`install --index-url http://127.0.0.1:${port}/simple senpi-slow`,
			controller.signal,
		);

		await expect(pending).rejects.toMatchObject({ code: "environment_install_cancelled" });
		expect(performance.now() - abortedAt).toBeLessThan(2_000);
		expect(await readActiveRevision(base)).toEqual({ number: 1, dir: first.root });
		expect((await readdir(base)).some((name) => name.startsWith(".staging"))).toBe(false);
	});

	it("When two sessions install into one root at once, then the lock serialises them and the second builds on the first", async () => {
		const { root, base, wheels } = await workspace();
		const probeA = buildWheel(wheels, "senpi_probe_a", "1.0");
		const probeB = buildWheel(wheels, "senpi_probe_b", "2.0");

		const receipts = await Promise.all([
			install(base, root, `install --no-index ${probeA}`),
			install(base, root, `install --no-index ${probeB}`),
		]);

		expect(receipts.map((receipt) => receipt.revision).sort()).toEqual([1, 2]);
		const active = await readActiveRevision(base);
		expect(active?.number).toBe(2);
		expect(importFrom(active?.dir ?? "", "senpi_probe_a")).toBe("1.0");
		expect(importFrom(active?.dir ?? "", "senpi_probe_b")).toBe("2.0");
		const firstRevision = receipts.find((receipt) => receipt.revision === 1)?.root ?? "";
		const inFirst = ["senpi_probe_a", "senpi_probe_b"].filter((name) => existsSync(join(firstRevision, name)));
		expect(inFirst).toHaveLength(1);
	});

	it("When a lock left by a process that has exited is found, then the install takes it over", async () => {
		const { root, base, wheels } = await workspace();
		const exited = spawnSync("python3", ["-c", "import os; print(os.getpid())"], { encoding: "utf8" });
		await mkdir(base, { recursive: true });
		await writeFile(
			join(base, ".install.lock"),
			JSON.stringify({ pid: Number(exited.stdout.trim()), host: hostname() }),
		);

		const receipt = await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);

		expect(receipt.revision).toBe(1);
	});

	it("When pip installs, then the interpreter's own site-packages and the user site are left byte-identical", async () => {
		const { root, base, wheels } = await workspace();
		const before = siteFilesSnapshot();

		await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);

		expect(siteFilesSnapshot()).toBe(before);
	});
});

describe("Given pip arguments from a magic cell", () => {
	it.each([
		["--target /tmp/elsewhere x"],
		["--target=/tmp/elsewhere x"],
		["-t/tmp/elsewhere x"],
		["--user x"],
		["--prefix=/usr x"],
		["--root / x"],
		["-e ."],
	])("When they include a destination flag (%s), then they are refused", (args) => {
		expect(() => parsePipRequirements(`install ${args}`)).toThrow(/environment_install_failed: .* is not allowed/);
	});

	it("When the command is not install, then it is refused with the supported form", () => {
		expect(() => parsePipRequirements("uninstall x")).toThrow(/only `%pip install <requirements>` is supported/);
	});

	it("When only requirements and ordinary flags are given, then they pass through as an argv", () => {
		expect(parsePipRequirements("install --no-index  six==1.16.0 ./x.whl")).toEqual([
			"--no-index",
			"six==1.16.0",
			"./x.whl",
		]);
	});
});
