// senpi#5635: while a worker pins its env view (it dropped session keys or the RPC host's hand-off), every Bun
// spawn path gets that view: a spawn from a settled cell (a timer) and a `new Bun.$.Shell()` instance included.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { emitter, type InstallShellCapture, installFakeBun } from "./eval/fake-bun-shell.ts";

const captureModuleUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "worker-shell-capture.js")).href;

async function loadInstallShellCapture(): Promise<InstallShellCapture> {
	const loaded: unknown = await import(captureModuleUrl);
	const install: unknown =
		typeof loaded === "object" && loaded !== null ? Reflect.get(loaded, "installShellCapture") : undefined;
	if (typeof install !== "function") throw new Error("worker-shell-capture.js does not export installShellCapture");
	return (options) => Reflect.apply(install, undefined, [options]);
}

const hadBun = Object.hasOwn(globalThis, "Bun");
const originalBun: unknown = Reflect.get(globalThis, "Bun");
let restore = (): void => {};

afterEach(() => {
	restore();
	restore = () => {};
	Reflect.deleteProperty(globalThis, "__senpi_session_env_deletions__");
	Reflect.deleteProperty(globalThis, "__senpi_session_env_applied__");
	if (hadBun) Object.defineProperty(globalThis, "Bun", { value: originalBun, configurable: true, writable: true });
	else Reflect.deleteProperty(globalThis, "Bun");
});

describe("issue #5635 the worker env pin covers every Bun spawn path", () => {
	it("a Bun.spawn after the cell settled still gets the pinned view", async () => {
		// Given: a worker that dropped a hand-off name, and no active cell.
		const install = await loadInstallShellCapture();
		const fake = installFakeBun();
		globalThis.__senpi_session_env_deletions__ = ["SENPI_RPC_HOST_INSTANCE_ID"];
		restore = install({ isActive: () => false, emitText: emitter().emitText });

		// When: a late timer spawns without an env, and another with its own.
		fake.bun.spawn(["env"]);
		fake.bun.spawn({ cmd: ["env"] });
		fake.bun.spawn(["keep"], { env: { CUSTOM: "1" } });

		// Then: the default-env spawns get the worker view; an explicit env is kept.
		expect(fake.spawnCalls[0]?.options.env).toEqual({ ...process.env });
		expect(fake.spawnCalls[1]?.options.env).toEqual({ ...process.env });
		expect(fake.spawnCalls[2]?.options.env).toEqual({ CUSTOM: "1" });
	});

	it("a new Bun.$.Shell() instance starts from the pinned view", async () => {
		// Given: a pinning worker whose Bun exposes a Shell class.
		const install = await loadInstallShellCapture();
		const fake = installFakeBun();
		const seeded: unknown[] = [];
		class RecordingShell {
			env(values: unknown): RecordingShell {
				seeded.push(values);
				return this;
			}
		}
		Object.assign(fake.bun.$, { Shell: RecordingShell });
		globalThis.__senpi_session_env_deletions__ = ["SENPI_RPC_HOST_INSTANCE_ID"];
		restore = install({ isActive: () => true, emitText: emitter().emitText });

		// When: a cell builds its own shell.
		const Shell: unknown = Reflect.get(Reflect.get(globalThis, "Bun").$, "Shell");
		if (typeof Shell !== "function") throw new Error("captured Bun.$ has no Shell");
		Reflect.construct(Shell, []);

		// Then: the instance was seeded with the worker view before use.
		expect(seeded).toEqual([{ ...process.env }]);
	});
});
