// senpi#5349 (A8, N1): the worker's kill guard reads the process table and runs its dry run through the originals it
// captured before the cell wrappers were installed, so judging never re-enters a judging wrapper.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KILL_GUARD_MODULE_URL } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it } from "vitest";

const captureUrl = pathToFileURL(join(process.cwd(), "src", "kernels", "js", "worker-shell-capture.js")).href;

type SpawnSyncResult = { success: boolean; exitCode: number; stdout: Uint8Array; stderr: Uint8Array };

const encode = (text: string) => new TextEncoder().encode(text);

// The fake Bun global stands in for the runtime's own, so this runs where vitest runs on Node.
const nodeRuntime = !Object.hasOwn(globalThis, "Bun");

describe.runIf((process.platform === "darwin" || process.platform === "linux") && nodeRuntime)(
	"worker kill guard (A8)",
	() => {
		let restore: (() => void) | undefined;

		afterEach(() => {
			restore?.();
			restore = undefined;
			Reflect.deleteProperty(globalThis, "Bun");
		});

		it("judges a wrapped spawnSync with the captured originals and never re-enters the wrapper (N1)", async () => {
			const originalCalls: string[] = [];
			const spawnSync = (argv: readonly string[]): SpawnSyncResult => {
				originalCalls.push(String(argv[0]));
				const stdout =
					argv[0] === "ps"
						? `1 0 1 1 0 launchd /sbin/launchd\n${process.pid} 1 ${process.pid} ${process.pid} 501 node node vitest\n600 1 600 600 501 node node vite --port 5173\n`
						: argv[0] === "pgrep"
							? "600\n"
							: "";
				return { success: true, exitCode: argv[0] === "pgrep" ? 0 : 0, stdout: encode(stdout), stderr: encode("") };
			};
			const shell = Object.assign(() => Promise.resolve(), { escape: (value: string) => value });
			Object.defineProperty(globalThis, "Bun", {
				configurable: true,
				value: { $: shell, spawn: () => ({}), spawnSync },
			});
			const capture: { installShellCapture: (options: unknown) => () => void } = await import(captureUrl);
			const judge: unknown = await import(String(KILL_GUARD_MODULE_URL));
			restore = capture.installShellCapture({
				isActive: () => true,
				emitText: () => {},
				killGuard: { judge, agentPid: process.pid },
			});
			const bun = Reflect.get(globalThis, "Bun") as { spawnSync: (argv: readonly string[]) => SpawnSyncResult };
			const wrapped = bun.spawnSync;
			let wrapperEntries = 0;
			bun.spawnSync = (argv) => {
				wrapperEntries += 1;
				return wrapped(argv);
			};

			bun.spawnSync(["pkill", "-f", "vite --port 5173"]);

			expect(wrapperEntries).toBe(1);
			const viewReads = process.platform === "darwin" ? ["ps"] : [];
			expect(originalCalls).toEqual([...viewReads, "pgrep", "pkill"]);
		});

		it("refuses a broad pattern without reading the table", async () => {
			const originalCalls: string[] = [];
			Object.defineProperty(globalThis, "Bun", {
				configurable: true,
				value: {
					$: Object.assign(() => Promise.resolve(), { escape: (value: string) => value }),
					spawn: () => ({}),
					spawnSync: (argv: readonly string[]) => {
						originalCalls.push(String(argv[0]));
						return { success: true, exitCode: 0, stdout: encode(""), stderr: encode("") };
					},
				},
			});
			const capture: { installShellCapture: (options: unknown) => () => void } = await import(captureUrl);
			const judge: unknown = await import(String(KILL_GUARD_MODULE_URL));
			restore = capture.installShellCapture({
				isActive: () => false,
				emitText: () => {},
				killGuard: { judge, agentPid: process.pid },
			});
			const bun = Reflect.get(globalThis, "Bun") as { spawnSync: (argv: readonly string[]) => unknown };

			expect(() => bun.spawnSync(["pkill", "-f", ".*"])).toThrow("[senpi:kill-guard]");
			expect(originalCalls).toEqual([]);
		});

		it("judges every shell a cell builds with new Bun.$.Shell(), shaped as on Bun 1.4.4", async () => {
			const ran: string[] = [];
			const escape = (value: string) => value;
			// As on Bun 1.4.4: an instance's only own enumerable key is a read-only `name`, it has no `escape`, and
			// `Bun.$.Shell` is non-writable and non-configurable.
			function Shell() {
				const instance = (strings: TemplateStringsArray) => {
					ran.push(strings.join(""));
					return Promise.resolve();
				};
				return Object.defineProperty(instance, "name", { value: "Shell", enumerable: true });
			}
			const $ = Object.defineProperty(
				Object.assign(() => Promise.resolve(), { escape }),
				"Shell",
				{
					value: Shell,
					enumerable: true,
				},
			);
			Object.defineProperty(globalThis, "Bun", {
				configurable: true,
				value: {
					$,
					spawn: () => ({}),
					spawnSync: () => ({ success: true, exitCode: 0, stdout: encode(""), stderr: encode("") }),
				},
			});
			const capture: { installShellCapture: (options: unknown) => () => void } = await import(captureUrl);
			const judge: unknown = await import(String(KILL_GUARD_MODULE_URL));
			restore = capture.installShellCapture({
				isActive: () => false,
				emitText: () => {},
				killGuard: { judge, agentPid: process.pid },
			});
			const bun = Reflect.get(globalThis, "Bun") as {
				$: { Shell: new () => (strings: TemplateStringsArray) => Promise<void> };
			};
			const shell = new bun.$.Shell();

			expect(() => shell`pkill -f 'a||b'`).toThrow("[senpi:kill-guard]");
			await shell`echo fine`;
			expect(ran).toEqual(["echo fine"]);
		});
	},
);
