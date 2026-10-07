import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readActiveRevision } from "../../src/environments/revision-store.ts";
import { hasCommand, packFixture, session, textOf } from "./js-magic-session.ts";

const probeSource = 'export const probe = () => "ok";\n';

describe.skipIf(!hasCommand("bun") || !hasCommand("npm"))("Given a JavaScript install that is stopped part way", () => {
	it("When the cell is cancelled once the installer has started, then nothing is published, the project manifest is unchanged and the kernel answers the next cell", async () => {
		const { root, project, fixtures, environments, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-probe", "1.0.0", probeSource);
		const manifest = await readFile(join(project, "package.json"), "utf8");
		const controller = new AbortController();
		const installerStarted = Promise.withResolvers<void>();
		const original = environments.install.bind(environments);
		environments.install = (requested, signal, onOutput, installer) =>
			original(
				requested,
				signal,
				(stream, data) => {
					installerStarted.resolve();
					onOutput?.(stream, data);
				},
				installer,
			);

		const pending = run(`%npm add ${tarball}`, controller.signal);
		await installerStarted.promise;
		controller.abort();
		await expect(pending).rejects.toThrow(/interrupted|aborted/i);
		const next = await run("40 + 2");

		expect(environments.packageRoot).toBeUndefined();
		expect(await readActiveRevision(join(root, "artifacts", "environments", "js", "test"))).toBeUndefined();
		expect(await readFile(join(project, "package.json"), "utf8")).toBe(manifest);
		expect(textOf(next)).toContain("42");
	}, 180_000);

	it("When the session closes while an install runs, then the install is stopped and no revision is published afterwards", async () => {
		const { root, fixtures, environments, run, dispose } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-close-probe", "1.0.0", probeSource);
		const installStarted = Promise.withResolvers<{ readonly installing: Promise<unknown> }>();
		const original = environments.install.bind(environments);
		const installerOutput = Promise.withResolvers<void>();
		environments.install = (requested, signal, onOutput, installer) => {
			const installing = original(
				requested,
				signal,
				(stream, data) => {
					installerOutput.resolve();
					onOutput?.(stream, data);
				},
				installer,
			);
			installStarted.resolve({ installing });
			return installing;
		};

		const pending = run(`%npm add ${tarball}`).catch((error: unknown) => error);
		const { installing } = await installStarted.promise;
		await installerOutput.promise;
		await dispose();
		const outcome = await installing.then(
			() => "published",
			() => "stopped",
		);
		await pending;

		expect(outcome).toBe("stopped");
		expect(await readActiveRevision(join(root, "artifacts", "environments", "js", "test"))).toBeUndefined();
	}, 180_000);

	it("When the worker crashes while npm waits on the registry, then npm is stopped, the cell names the crash, and no revision is published", async () => {
		const { root, run } = await session("npm");
		const marker = join(root, "crash-now");
		const requested = Promise.withResolvers<void>();
		const dropped = Promise.withResolvers<void>();
		// The registry takes the request and never answers, so the install is reliably still running when the
		// worker crashes; the dropped connection shows npm itself was stopped.
		const registry = createServer((request) => {
			request.socket.once("close", () => dropped.resolve());
			writeFileSync(marker, "");
			requested.resolve();
		});
		await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
		const { port } = registry.address() as AddressInfo;
		try {
			await run(
				`import { existsSync } from "node:fs";\nconst crashTimer = setInterval(() => { if (existsSync(${JSON.stringify(marker)})) { clearInterval(crashTimer); throw new Error("stray timer"); } }, 5);\n"armed"`,
			);

			const install = run(`%npm add http://127.0.0.1:${port}/senpi-hang-1.0.0.tgz`);
			await requested.promise;
			const stopped = await Promise.race([
				dropped.promise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
			]);
			const result = await Promise.race([install, new Promise<undefined>((resolve) => setTimeout(resolve, 20_000))]);
			const base = join(root, "artifacts", "environments", "js", "test");

			expect(stopped).toBe(true);
			expect(result?.details).toHaveProperty("isError", true);
			expect(textOf(result as NonNullable<typeof result>)).toContain("JavaScript worker crashed: stray timer");
			expect(await readActiveRevision(base)).toBeUndefined();
			expect(existsSync(base) ? readdirSync(base).filter((name) => /^rev-\d+$/.test(name)) : []).toEqual([]);
		} finally {
			registry.closeAllConnections();
			registry.close();
		}
	}, 180_000);

	it("When an install is cancelled and the installer's group can no longer be signalled, then the installer itself is still stopped", async () => {
		const { run } = await session("npm");
		const requested = Promise.withResolvers<void>();
		const dropped = Promise.withResolvers<void>();
		const registry = createServer((request) => {
			request.socket.once("close", () => dropped.resolve());
			requested.resolve();
		});
		await new Promise<void>((resolve) => registry.listen(0, "127.0.0.1", resolve));
		const { port } = registry.address() as AddressInfo;
		const kill = process.kill.bind(process);
		// macOS answers EPERM for a process group whose leader already exited.
		const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (typeof pid === "number" && pid < 0) {
				throw Object.assign(new Error("kill EPERM"), { code: "EPERM", errno: -1, syscall: "kill" });
			}
			return kill(pid, signal);
		});
		const controller = new AbortController();
		try {
			const install = run(`%npm add http://127.0.0.1:${port}/senpi-cancel-1.0.0.tgz`, controller.signal).then(
				() => undefined,
				(error: unknown) => error,
			);
			await requested.promise;
			controller.abort();
			const stopped = await Promise.race([
				dropped.promise.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
			]);
			const rejection = await install;

			expect(stopped).toBe(true);
			expect(rejection).toMatchObject({ name: "AbortError" });
		} finally {
			groupKill.mockRestore();
			registry.closeAllConnections();
			registry.close();
		}
	}, 180_000);
	it("When an install is aborted while it waits for another session's install lock, then it is reported as cancelled", async () => {
		const { root, environments } = await session("npm");
		const base = join(root, "artifacts", "environments", "js", "test");
		await mkdir(base, { recursive: true });
		// A live holder on this host (this very process) is never stale, so the install waits for it.
		await writeFile(
			join(base, ".install.lock"),
			JSON.stringify({ pid: process.pid, host: hostname(), nonce: "another-session" }),
		);
		// The first abort listener on the signal is the lock wait's; the installer registers its own only once it holds the
		// lock. Aborting as soon as that first listener is registered is an abort mid-wait, with no timing involved.
		const controller = new AbortController();
		const { signal } = controller;
		const listen = signal.addEventListener.bind(signal);
		let waiting = false;
		signal.addEventListener = (...args: Parameters<AbortSignal["addEventListener"]>) => {
			listen(...args);
			if (args[0] === "abort" && !waiting) {
				waiting = true;
				queueMicrotask(() => controller.abort());
			}
		};

		const error = await environments.install("left-pad", signal).then(
			() => undefined,
			(failure: unknown) => failure,
		);

		expect(waiting).toBe(true);
		expect(error).toMatchObject({ code: "environment_install_cancelled" });
	}, 60_000);

	it("When publishing the new revision fails, then the cell reports the failure without any host path", async () => {
		const { root, fixtures, environments, run } = await session("npm");
		const tarball = await packFixture(fixtures, "senpi-publish-blocked", "1.0.0", probeSource);
		const base = join(root, "artifacts", "environments", "js", "test");
		const original = environments.install.bind(environments);
		let blocked = false;
		environments.install = (requested, signal, onOutput, installer) =>
			original(
				requested,
				signal,
				(stream, data) => {
					// The target name is taken while the installer runs, so the publish rename meets a non-empty directory.
					if (!blocked) {
						blocked = true;
						mkdirSync(join(base, "rev-1", "occupied"), { recursive: true });
					}
					onOutput?.(stream, data);
				},
				installer,
			);

		const install = await run(`%npm add ${tarball}`);

		expect(blocked).toBe(true);
		expect(install.details).toHaveProperty("isError", true);
		expect(textOf(install)).toContain("could not publish the new revision");
		expect(textOf(install)).not.toContain(root);
	}, 180_000);
});
