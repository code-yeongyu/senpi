import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
	rejectRealpath: false,
	hangOpendir: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (...args: Parameters<typeof actual.realpath>) => {
			if (fsState.rejectRealpath) {
				throw Object.assign(new Error(`EACCES: permission denied, realpath '${String(args[0])}'`), {
					code: "EACCES",
				});
			}
			return actual.realpath(...args);
		},
		opendir: async (...args: Parameters<typeof actual.opendir>) => {
			if (fsState.hangOpendir) return await new Promise<never>(() => {});
			return actual.opendir(...args);
		},
	};
});

import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { getApprovedMonitorParent } from "../../src/core/extensions/builtin/terminal/monitor-permission.ts";
import { type MonitorEvent, MonitorRegistry } from "../../src/core/extensions/builtin/terminal/monitor-registry.ts";

const isWindows = process.platform === "win32";

class EventSink {
	readonly #listeners = new Set<(event: MonitorEvent) => void>();

	push(event: MonitorEvent): void {
		for (const listener of this.#listeners) listener(event);
	}

	waitFor(predicate: (event: MonitorEvent) => boolean, label: string): Promise<MonitorEvent> {
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.#listeners.delete(listener);
				reject(new Error(`Timed out waiting for ${label}`));
			}, 5000);
			const listener = (event: MonitorEvent) => {
				if (!predicate(event)) return;
				clearTimeout(timeout);
				this.#listeners.delete(listener);
				resolve(event);
			};
			this.#listeners.add(listener);
		});
	}
}

function approvedParentFor(path: string, cwd: string): string | undefined {
	const input: Record<string, unknown> = { description: "probe", path };
	createBuiltinParserRegistry().parse("monitor", input, cwd);
	return getApprovedMonitorParent(input);
}

describe("file monitor parent resolution", () => {
	const roots: string[] = [];
	const registries: MonitorRegistry[] = [];

	async function createRoot(prefix: string): Promise<string> {
		const root = await mkdtemp(join(process.cwd(), prefix));
		roots.push(root);
		return root;
	}

	function createRegistry(sink: EventSink): MonitorRegistry {
		const registry = new MonitorRegistry((event) => sink.push(event));
		registries.push(registry);
		return registry;
	}

	afterEach(async () => {
		fsState.rejectRealpath = false;
		fsState.hangOpendir = false;
		while (registries.length > 0) registries.pop()?.dispose();
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) await rm(root, { recursive: true, force: true });
		}
	});

	it("registers and fires a create watch while fs.promises.realpath is unusable", async () => {
		// given
		const root = await createRoot(".parent-resolution-");
		const sink = new EventSink();
		const registry = createRegistry(sink);
		fsState.rejectRealpath = true;

		// when
		const line = sink.waitFor((event) => event.type === "line", "file create");
		await registry.registerFile({
			description: "no-realpath",
			path: join(root, "artifact"),
			event: "create",
			timeoutMs: 5000,
			cwd: root,
		});
		await writeFile(join(root, "artifact"), "created");

		// then
		expect((await line).type).toBe("line");
	}, 15_000);

	it("rejects at the registration deadline when the parent directory cannot be opened", async () => {
		// given
		const root = await createRoot(".parent-resolution-");
		const registry = createRegistry(new EventSink());
		fsState.hangOpendir = true;

		// when
		const registration = registry.registerFile({
			description: "wedged parent",
			path: join(root, "artifact"),
			event: "create",
			timeoutMs: 200,
			cwd: root,
		});

		// then
		await expect(registration).rejects.toThrow(/timed out|disposed/);
	}, 15_000);

	it.skipIf(isWindows)(
		"accepts the parent the permission parser approved through a symlink",
		async () => {
			// given
			const root = await createRoot(".parent-resolution-");
			const real = join(root, "real");
			const link = join(root, "link");
			await mkdir(real);
			await symlink(real, link, "dir");
			const registry = createRegistry(new EventSink());
			const requested = join(link, "artifact");
			const approvedParent = approvedParentFor(requested, root);

			// when / then
			expect(approvedParent).toBe(real);
			await expect(
				registry.registerFile({
					description: "symlinked parent",
					path: requested,
					event: "create",
					timeoutMs: 5000,
					cwd: root,
					approvedParent,
				}),
			).resolves.toMatchObject({ id: expect.stringMatching(/^watch_\d+$/) });
		},
		15_000,
	);

	it.skipIf(isWindows)(
		"rejects when the approved parent is swapped for a symlink to another directory",
		async () => {
			// given
			const root = await createRoot(".parent-resolution-");
			const outside = await createRoot(".parent-resolution-outside-");
			const parent = join(root, "parent");
			await mkdir(parent);
			const requested = join(parent, "artifact");
			const approvedParent = approvedParentFor(requested, root);
			expect(approvedParent).toBe(parent);
			await rename(parent, join(root, "moved"));
			await symlink(outside, parent, "dir");
			const registry = createRegistry(new EventSink());

			// when / then
			await expect(
				registry.registerFile({
					description: "swapped parent",
					path: requested,
					event: "create",
					timeoutMs: 5000,
					cwd: root,
					approvedParent,
				}),
			).rejects.toThrow(/parent directory changed during permission approval/);
		},
		15_000,
	);
});
