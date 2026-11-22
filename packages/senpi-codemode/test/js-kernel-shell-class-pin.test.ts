// senpi#7034 (design from senpi#5635): while a worker pins its env view (it dropped session keys or the RPC host's
// hand-off), a `new Bun.$.Shell()` instance starts from that view too, not from the OS environ.
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

describe("issue #7034 the worker env pin covers Bun.$.Shell instances", () => {
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
