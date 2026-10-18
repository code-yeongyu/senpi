import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertInstalledInRevision, assertNoEditableInstalls } from "../../src/environments/editable-check.ts";
import { withRootLock } from "../../src/environments/install-lock.ts";
import { installPythonPackages } from "../../src/environments/py-environment.ts";
import { isolatedPipEnv, parsePipRequirements, runPipInstall } from "../../src/environments/py-installer.ts";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { createInterpreterDetector } from "../../src/interpreters/detect.ts";
import {
	buildWheel,
	editableBackend,
	fixtureDir,
	hasPythonWithPip,
	importFrom,
	siteFilesSnapshot,
} from "./wheel-fixtures.ts";

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
	for (const outcome of ["success", "failure", "cancel"] as const) {
		it(`pip scratch is owned and removed after ${outcome} (#3064)`, async () => {
			const { root } = await workspace();
			const target = join(root, "target");
			await mkdir(target);
			// Exercise the actual Python subprocess and its tempfile behavior, including a killed
			// installer that cannot run Python's own cleanup.
			await writeFile(
				join(root, "pip.py"),
				`
import json, os, sys, tempfile, threading
scratch = tempfile.mkdtemp(prefix="pip-install-")
print(json.dumps({"scratch": scratch, "tmp": os.environ.get("TMP"), "temp": os.environ.get("TEMP")}), flush=True)
${outcome === "cancel" ? "threading.Event().wait()" : `sys.exit(${outcome === "failure" ? 3 : 0})`}
`,
			);
			const controller = new AbortController();
			let observed: { scratch: string; tmp: string; temp: string } | undefined;
			let stdout = "";
			const pending = runPipInstall({
				interpreter: "python3",
				root: target,
				args: ["probe"],
				cwd: root,
				signal: controller.signal,
				onOutput(stream, data) {
					if (stream !== "stdout") return;
					stdout += data;
					const newline = stdout.indexOf("\n");
					if (newline < 0 || observed) return;
					observed = JSON.parse(stdout.slice(0, newline));
					if (outcome === "cancel") controller.abort();
				},
			});
			if (outcome === "success") await pending;
			else
				await expect(pending).rejects.toMatchObject({
					code: outcome === "cancel" ? "environment_install_cancelled" : "environment_install_failed",
				});
			expect(observed).toBeDefined();
			if (!observed) throw new Error("installer did not report its scratch");
			try {
				expect(observed.scratch.startsWith(`${target}/`) || observed.scratch.startsWith(`${target}\\`)).toBe(true);
				expect(observed.tmp).toBe(observed.temp);
				expect(observed.scratch.startsWith(observed.tmp)).toBe(true);
				expect(existsSync(observed.scratch)).toBe(false);
				expect(await readdir(target)).toEqual([]);
			} finally {
				// RED runs create an OS-temp entry; remove only the path reported by our child.
				await rm(observed.scratch, { recursive: true, force: true });
			}
		});
	}

	it("When a local wheel installs, then it is published as the active revision and imports from it", async () => {
		const { root, base, wheels } = await workspace();
		const wheel = buildWheel(wheels, "senpi_probe", "1.0");

		const receipt = await install(base, root, `install --no-index ${wheel}`);

		expect(receipt).toMatchObject({ manager: "pip", revision: 1, changed: true, resolved: ["senpi-probe-1.0"] });
		expect((await readActiveRevision(base))?.number).toBe(1);
		expect(importFrom(receipt.root, "senpi_probe")).toBe("1.0");
	});

	it("When packages.install() passes a requirement list, then each item reaches pip as one argument: a path with a space and a marker stay intact", async () => {
		const { root, base, wheels } = await workspace();
		const spaced = join(wheels, "with space");
		await mkdir(spaced, { recursive: true });
		buildWheel(spaced, "senpi_probe", "1.0");

		const receipt = await installPythonPackages({
			base,
			mode: "managed",
			interpreter: "python3",
			requirements: ["--no-index", "--find-links", spaced, 'senpi_probe; python_version >= "3.0"'],
			cwd: root,
			signal: new AbortController().signal,
		});

		expect(receipt).toMatchObject({ revision: 1, changed: true });
		expect(receipt.resolved).toEqual([expect.stringMatching(/^senpi[-_]probe-1\.0$/)]);
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

	it.each([
		["a requirements file", { "reqs.txt": "-e ./pkg\n" }, "-r reqs.txt"],
		[
			"a constraint file included from a requirements file",
			{ "reqs.txt": "-r nested/more.txt\n", "nested/more.txt": "-e ./pkg\n" },
			"-r reqs.txt",
		],
		["a line after a comment that ends in a backslash", { "reqs.txt": "# note \\\n-e ./pkg\n" }, "-r reqs.txt"],
	])(
		"When %s asks for an editable install, then it is refused and nothing is published",
		async (_case, files, args) => {
			const { root, base } = await workspace();
			await mkdir(join(root, "pkg"), { recursive: true });
			await writeFile(
				join(root, "pkg", "pyproject.toml"),
				'[build-system]\nrequires = []\nbuild-backend = "senpi_backend"\nbackend-path = ["."]\n[project]\nname = "senpi-editable"\nversion = "1.0"\n',
			);
			await writeFile(join(root, "pkg", "senpi_backend.py"), editableBackend);
			for (const [name, text] of Object.entries(files)) {
				await mkdir(join(root, name, ".."), { recursive: true });
				await writeFile(join(root, name), text);
			}

			await expect(install(base, root, `install --no-index ${args}`)).rejects.toThrow(
				/senpi[-_]editable.* was installed as an editable install/,
			);
			expect(await readActiveRevision(base)).toBeUndefined();
		},
	);

	it("When a pip config file names a root to install under, then the install still lands only in the revision", async () => {
		const { root, base, wheels } = await workspace();
		const elsewhere = join(root, "elsewhere");
		const config = join(root, "pip.conf");
		await writeFile(config, `[install]\nroot = ${elsewhere}\n`);
		const previous = process.env.PIP_CONFIG_FILE;
		process.env.PIP_CONFIG_FILE = config;
		try {
			const receipt = await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);

			expect(importFrom(receipt.root, "senpi_probe")).toBe("1.0");
			expect(existsSync(elsewhere)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PIP_CONFIG_FILE;
			else process.env.PIP_CONFIG_FILE = previous;
		}
	});

	it("When pip's environment names a root to install under, then the install still lands only in the revision", async () => {
		const { root, base, wheels } = await workspace();
		const elsewhere = join(root, "elsewhere");
		const previous = process.env.PIP_ROOT;
		process.env.PIP_ROOT = elsewhere;
		try {
			const receipt = await install(base, root, `install --no-index ${buildWheel(wheels, "senpi_probe", "1.0")}`);

			expect(importFrom(receipt.root, "senpi_probe")).toBe("1.0");
			expect(existsSync(elsewhere)).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.PIP_ROOT;
			else process.env.PIP_ROOT = previous;
		}
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
		["--targ /tmp/elsewhere x"],
		["--tar=/tmp/elsewhere x"],
		["--pref=/usr x"],
		["--roo / x"],
		["--edit ."],
		["-Ut/tmp/elsewhere x"],
		["-Ue."],
		["--src /tmp x"],
		["--isolated x"],
	])("When they include a destination flag (%s), then they are refused", (args) => {
		expect(() => parsePipRequirements(`install ${args}`)).toThrow(/environment_install_failed: .* is not allowed/);
	});

	it("When the command is not install, then it is refused with the supported form", () => {
		expect(() => parsePipRequirements("uninstall x")).toThrow(/only `%pip install <requirements>` is supported/);
	});

	it("When allowed options use short or attached spellings, then they are passed to pip spelled out in full", () => {
		expect(parsePipRequirements("install -U -q --index-url https://pypi.example/simple -f ./wheels x")).toEqual([
			"--upgrade",
			"--quiet",
			"--index-url=https://pypi.example/simple",
			"--find-links=./wheels",
			"x",
		]);
	});

	it.each([["--index-url"], ["--upgrade=1"], ["--find-links --no-index"]])(
		"When an option's value is missing or not allowed (%s), then the arguments are refused",
		(args) => {
			expect(() => parsePipRequirements(`install ${args} x`)).toThrow(/environment_install_failed/);
		},
	);

	it("When only requirements and ordinary flags are given, then they pass through as an argv", () => {
		expect(parsePipRequirements("install --no-index  six==1.16.0 ./x.whl")).toEqual([
			"--no-index",
			"six==1.16.0",
			"./x.whl",
		]);
	});
});

describe("Given a staged revision pip has just written", () => {
	async function staged(): Promise<{ readonly staging: string; readonly outside: string }> {
		const root = await mkdtemp(join(tmpdir(), "senpi-staged-"));
		roots.push(root);
		const staging = join(root, "rev-1");
		const outside = join(root, "checkout");
		await mkdir(join(staging, "pkg"), { recursive: true });
		await mkdir(outside, { recursive: true });
		return { staging, outside };
	}

	// pip 24's `setup.py develop` path leaves an egg-link and an easy-install.pth line, and no direct_url.json.
	it("When it holds a legacy develop install's egg-link, then the revision is refused", async () => {
		const { staging, outside } = await staged();
		await writeFile(join(staging, "senpi-legacy.egg-link"), `${outside}\n.\n`);

		await expect(assertNoEditableInstalls(staging)).rejects.toThrow(
			/senpi-legacy was installed as a legacy editable install/,
		);
	});

	it("When a .pth line points outside the revision, then the revision is refused", async () => {
		const { staging, outside } = await staged();
		await writeFile(join(staging, "easy-install.pth"), `${outside}\n`);

		await expect(assertNoEditableInstalls(staging)).rejects.toThrow(/a path outside the environment/);
	});

	it("When an entry is a link to a directory outside the revision, then the revision is refused", async () => {
		const { staging, outside } = await staged();
		await symlink(outside, join(staging, "linked"));

		await expect(assertNoEditableInstalls(staging)).rejects.toThrow(/a link that points outside the environment/);
	});

	it("When a link deep inside a package points outside the revision, then the revision is refused", async () => {
		const { staging, outside } = await staged();
		await mkdir(join(staging, "pkg", "data"), { recursive: true });
		await symlink(outside, join(staging, "pkg", "data", "linked"));

		await expect(assertNoEditableInstalls(staging)).rejects.toThrow(/a link that points outside the environment/);
	});

	it("When pip reports a distribution the revision doesn't contain, then the install fails instead of publishing it empty", async () => {
		const { staging } = await staged();
		await mkdir(join(staging, "senpi_probe-1.0.dist-info"));

		await expect(
			assertInstalledInRevision("Successfully installed Senpi.Probe-1.0 other-pkg-2.1\n", staging),
		).rejects.toThrow(/other-pkg was installed outside the session's environment/);
		await expect(
			assertInstalledInRevision("Successfully installed Senpi.Probe-1.0\n", staging),
		).resolves.toBeUndefined();
	});

	it("When an old pip installed a setup.py project as an egg-info inside the revision, then it is accepted", async () => {
		const { staging } = await staged();
		await mkdir(join(staging, "senpi_legacy-1.0-py3.11.egg-info"));

		await expect(
			assertInstalledInRevision("Successfully installed senpi-legacy-1.0\n", staging),
		).resolves.toBeUndefined();
	});

	it("When pip's config file is pointed at the null device, then it is the exact path the interpreter calls os.devnull, so pip skips every config file", async () => {
		// The interpreter the kernel resolves is the one whose pip installs into the environment.
		const python = await createInterpreterDetector().detect("py");
		if (!python.ok) throw new Error("no Python interpreter resolved; this test must run where the kernel can start");
		const executable = python.resolvedPath ?? python.path;
		const probe = spawnSync(executable, ["-c", "import os; print(os.devnull)"], { encoding: "utf8" });

		expect(probe.status, probe.stderr).toBe(0);
		expect(isolatedPipEnv().PIP_CONFIG_FILE).toBe(probe.stdout.trim());
	});

	it("When its .pth lines and links stay inside the revision, then it is accepted", async () => {
		const { staging } = await staged();
		await writeFile(join(staging, "inside.pth"), "pkg\n# a comment\nimport os\n");
		await symlink(join(staging, "pkg"), join(staging, "alias"));

		await expect(assertNoEditableInstalls(staging)).resolves.toBeUndefined();
	});
});

describe("Given an environment root's install lock", () => {
	async function lockRoot(): Promise<string> {
		const base = await mkdtemp(join(tmpdir(), "senpi-lock-"));
		roots.push(base);
		return base;
	}

	function exitedPid(): number {
		return Number(
			spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout,
		);
	}

	it("When several waiters find one dead holder's lock at once, then exactly one holder is ever inside, across many trials", async () => {
		const base = await lockRoot();
		const dead = exitedPid();
		let overlaps = 0;
		// The old check-then-remove takeover let two holders in on about a quarter of 8-waiter trials, so 40 clean
		// trials rule it out (0.77^40 < 1e-4).
		for (let trial = 0; trial < 40; trial++) {
			await writeFile(join(base, ".install.lock"), JSON.stringify({ pid: dead, host: hostname() }));
			let inside = 0;
			const holder = async () => {
				inside++;
				if (inside > 1) overlaps++;
				await new Promise((resolve) => setTimeout(resolve, 1));
				inside--;
			};
			await Promise.all(Array.from({ length: 8 }, () => withRootLock(base, holder)));
		}

		expect(overlaps).toBe(0);
	}, 180_000);

	it("When a waiter crashed while reaping a stale lock and left its claim behind, then the lock is still taken over by exactly one holder at a time", async () => {
		const base = await lockRoot();
		const dead = exitedPid();
		let overlaps = 0;
		for (let trial = 0; trial < 40; trial++) {
			await writeFile(
				join(base, ".install.lock"),
				JSON.stringify({ pid: dead, host: hostname(), nonce: `lock-${trial}` }),
			);
			await writeFile(
				join(base, `.install.lock.reap.lock-${trial}.0`),
				JSON.stringify({ pid: dead, host: hostname(), nonce: `t-${trial}` }),
			);
			let inside = 0;
			const holder = async () => {
				inside++;
				if (inside > 1) overlaps++;
				await new Promise((resolve) => setTimeout(resolve, 1));
				inside--;
			};
			await Promise.all(Array.from({ length: 8 }, () => withRootLock(base, holder, AbortSignal.timeout(30_000))));
		}

		expect(overlaps).toBe(0);
	}, 180_000);

	it("When the only waiter that claimed a stale lock died with no successor, then the next waiter takes the lock over promptly and clears the dead claims", async () => {
		const base = await lockRoot();
		const dead = exitedPid();
		await writeFile(join(base, ".install.lock"), JSON.stringify({ pid: dead, host: hostname(), nonce: "stale" }));
		await writeFile(
			join(base, ".install.lock.reap.stale.0"),
			JSON.stringify({ pid: dead, host: hostname(), nonce: "c0" }),
		);
		await writeFile(
			join(base, ".install.lock.reap.stale.1"),
			JSON.stringify({ pid: dead, host: hostname(), nonce: "c1" }),
		);
		const started = Date.now();

		const entered = await withRootLock(base, async () => "entered", AbortSignal.timeout(5_000));

		expect(entered).toBe("entered");
		expect(Date.now() - started).toBeLessThan(2_000);
		expect((await readdir(base)).filter((name) => name.startsWith(".install.lock.reap."))).toEqual([]);
	});

	it("When a live waiter is reaping a stale lock, then another waiter waits for it instead of reaping too", async () => {
		const base = await lockRoot();
		await writeFile(
			join(base, ".install.lock"),
			JSON.stringify({ pid: exitedPid(), host: hostname(), nonce: "stale" }),
		);
		const takeover = join(base, ".install.lock.reap.stale.0");
		await writeFile(takeover, JSON.stringify({ pid: process.pid, host: hostname(), nonce: "live" }));
		let entered = false;

		const waiting = withRootLock(base, async () => {
			entered = true;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(entered).toBe(false);
		await rm(takeover);
		await waiting;

		expect(entered).toBe(true);
	});

	it("When an empty lock file older than a few seconds is found (a crash between create and write), then it is taken over", async () => {
		const base = await lockRoot();
		const lock = join(base, ".install.lock");
		await writeFile(lock, "");
		const old = new Date(Date.now() - 60_000);
		await utimes(lock, old, old);

		const value = await withRootLock(base, async () => "ran", AbortSignal.timeout(10_000));

		expect(value).toBe("ran");
	});

	it("When a freshly created lock can't be read yet, then it is waited for, not taken over", async () => {
		const base = await lockRoot();
		await writeFile(join(base, ".install.lock"), "");

		const waited = withRootLock(base, async () => "ran", AbortSignal.timeout(1_500));

		await expect(waited).rejects.toThrow();
	});

	it("When a live process on this host holds the lock, then a waiter enters only after it is released", async () => {
		const base = await lockRoot();
		const order: string[] = [];
		let release = (): void => undefined;
		const held = withRootLock(base, async () => {
			order.push("first in");
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			order.push("first out");
		});
		while (order.length === 0) await new Promise((resolve) => setImmediate(resolve));

		const second = withRootLock(base, async () => {
			order.push("second in");
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		release();
		await Promise.all([held, second]);

		expect(order).toEqual(["first in", "first out", "second in"]);
	});
});
