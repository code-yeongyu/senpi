import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultCodemodeSettings } from "../../src/config/settings.ts";
import { PythonEnvironments } from "../../src/environments/python-environments.ts";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { createCodemodeSessionManager } from "../../src/extension/session-manager.ts";
import { createInterpreterDetector, getInterpreterAvailability } from "../../src/interpreters/detect.ts";
import { createEvalTool } from "../../src/tool/eval-tool.ts";
import { fakeExtensionContext } from "../eval/fakes.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";
import { buildWheel, hasPythonWithPip } from "./wheel-fixtures.ts";

const probeSource = 'export const probe = () => "ok";\n';

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given packages.install() in a JavaScript cell", () => {
	it("When it installs a local tarball with bun, then it returns the receipt %bun add reports and the next cell imports the package", async () => {
		const { fixtures, run } = await session("bun");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);

		const install = await run(`JSON.stringify(await packages.install("bun", [${JSON.stringify(tarball)}]))`);
		const imported = await run('const { probe } = await import("senpi-probe");\nprobe()');

		const receipt = JSON.parse(JSON.parse(textOf(install).trim()));
		expect(receipt).toMatchObject({
			installer: "bun",
			mode: "managed",
			revision: 1,
			added: ["senpi-probe"],
			shadowed: [],
		});
		expect(textOf(imported)).toContain("ok");
	}, 180_000);

	it("When the owning cell is cancelled once the installer has started, then the install itself is cancelled, nothing is published and the kernel answers the next cell", async () => {
		const { root, fixtures, environments, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const controller = new AbortController();
		const installerStarted = Promise.withResolvers<void>();
		const installs: Promise<unknown>[] = [];
		const original = environments.install.bind(environments);
		environments.install = (requested, signal, onOutput, installer) => {
			const installing = original(
				requested,
				signal,
				(stream, data) => {
					installerStarted.resolve();
					onOutput?.(stream, data);
				},
				installer,
			);
			installs.push(installing);
			return installing;
		};

		const pending = run(`await packages.install("npm", ${JSON.stringify(tarball)})`, controller.signal);
		await installerStarted.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/interrupted|aborted/i);
		// The install runs on the host: wait for IT to settle, so a dropped signal would show as a published revision.
		expect(installs).toHaveLength(1);
		await expect(installs[0]).rejects.toThrow(/^environment_install_cancelled:/);
		const next = await run("40 + 2");

		expect(await readActiveRevision(join(root, "artifacts", "environments", "js", "test"))).toBeUndefined();
		expect(textOf(next)).toContain("42");
	}, 180_000);

	it("When the manager is not a JavaScript installer, then the cell fails with environment_installer_unavailable and installs nothing", async () => {
		const { run } = await session("bun");

		const result = await run('await packages.install("pip", "requests")');

		expect(textOf(result)).toContain("environment_installer_unavailable");
	}, 60_000);
});

const pySettings = { ...defaultCodemodeSettings, languages: { js: false, py: true, rb: false, jl: false } };
const pyAvailability = await getInterpreterAvailability(pySettings, createInterpreterDetector());
const pythonReady = pyAvailability.py.detected.ok && hasPythonWithPip();

async function pythonSession() {
	const root = await mkdtemp(join(tmpdir(), "senpi-packages-install-"));
	const wheels = join(root, "wheels");
	await mkdir(wheels, { recursive: true });
	const interpreter = pyAvailability.py.detected.ok ? pyAvailability.py.detected.path : "python3";
	const environments = new PythonEnvironments({
		artifactsDir: join(root, "artifacts"),
		cwd: root,
		interpreter,
		settings: pySettings,
	});
	const fail = async () => {
		throw new Error("no host tools or provider calls in this test");
	};
	const manager = await createCodemodeSessionManager({
		sessionId: `packages-install-${crypto.randomUUID()}`,
		cwd: root,
		settings: pySettings,
		availability: pyAvailability,
		executeTool: fail,
		complete: fail,
		environments: { python: environments },
	});
	const tool = createEvalTool({
		enabledLanguages: pySettings.languages,
		kernelManager: manager,
		executeTool: fail,
		cellTimeoutSeconds: 120,
		pythonEnvironments: environments,
	});
	const run = async (code: string, signal?: AbortSignal) =>
		await tool.execute(
			`packages-install-${crypto.randomUUID()}`,
			{ language: "py", code, summary: "Run a cell" },
			signal,
			undefined,
			fakeExtensionContext(),
		);
	const dispose = async () => {
		await manager.dispose();
		await rm(root, { recursive: true, force: true });
	};
	return { root, wheels, environments, run, dispose };
}

describe.skipIf(!pythonReady)("Given packages.install() in a Python cell", () => {
	it("When it installs a local wheel, then it returns the %pip receipt and the next cell imports the package", async () => {
		const { wheels, run, dispose } = await pythonSession();
		try {
			const wheel = buildWheel(wheels, "senpi_probe", "1.0");

			const install = await run(
				`import json\nr = packages.install("pip", ["--no-index", ${JSON.stringify(wheel)}])\njson.dumps({k: r[k] for k in ("manager", "mode", "revision", "resolved", "changed")})`,
			);
			const imported = await run("import senpi_probe; senpi_probe.VERSION");

			expect(textOf(install)).toContain('"manager": "pip"');
			expect(textOf(install)).toContain('"revision": 1');
			expect(textOf(install)).toContain('"resolved": ["senpi-probe-1.0"]');
			expect(textOf(install)).toContain('"changed": true');
			expect(textOf(imported)).toContain("'1.0'");
		} finally {
			await dispose();
		}
	}, 180_000);

	it("When the install fails, then the cell error carries environment_install_failed and pip's stderr tail", async () => {
		const { wheels, run, dispose } = await pythonSession();
		try {
			const broken = buildWheel(wheels, "senpi_broken", "1.0", ["senpi-nonexistent-dependency"]);

			const failure = await run(`packages.install("pip", ["--no-index", ${JSON.stringify(broken)}])`);

			expect(textOf(failure)).toContain("environment_install_failed");
			expect(textOf(failure)).toContain("No matching distribution");
		} finally {
			await dispose();
		}
	}, 180_000);

	it("When the owning cell is cancelled once pip has started, then the install itself is cancelled and nothing is published", async () => {
		const { root, environments, run, dispose } = await pythonSession();
		try {
			const controller = new AbortController();
			// An index that never answers keeps pip working until the cancel lands, so the test cannot race pip.
			const pipStarted = Promise.withResolvers<void>();
			const index = createServer(() => pipStarted.resolve());
			await new Promise<void>((resolve) => index.listen(0, "127.0.0.1", resolve));
			const address = index.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			const installs: Promise<unknown>[] = [];
			const original = environments.install.bind(environments);
			environments.install = (requested, signal, onOutput) => {
				const installing = original(requested, signal, onOutput);
				installs.push(installing);
				return installing;
			};

			const pending = run(
				`packages.install("pip", ["--index-url", "http://127.0.0.1:${port}/simple", "senpi-slow"])`,
				controller.signal,
			);
			await pipStarted.promise;
			controller.abort();
			await pending.catch(() => undefined);
			expect(installs).toHaveLength(1);
			await expect(installs[0]).rejects.toThrow(/^environment_install_cancelled:/);

			expect(await readActiveRevision(join(root, "artifacts", "environments", "py"))).toBeUndefined();
			await new Promise((resolve) => index.close(resolve));
		} finally {
			await dispose();
		}
	}, 180_000);
});
