/**
 * senpi#4382: `ensureHost` returns before the opportunistic gc pass it schedules has run, and that pass
 * writes `gc-last-run.json` into `<agentDir>/rpc-host-daemon`. A test that removes a tree holding that
 * agent directory while the pass is in flight fails with ENOTEMPTY on `rpc-host-daemon`.
 *
 * A per-test `afterEach` join cannot fix this for every test: Vitest runs setup-file `afterEach` hooks
 * AFTER the test file's own, which is where the removal happens, and many tests remove their tree in
 * `finally` or `afterAll`. So the join sits at the removal itself, for every test in this package:
 * `fs.promises.rm` (the `node:fs/promises` export too) waits for every overlapping pass first, and
 * `fs.rmSync`, which cannot wait, refuses while one is in flight.
 */
import fs, { type PathLike, type RmOptions } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import {
	opportunisticHostGcWithin,
	settledOpportunisticHostGcWithin,
} from "../../src/modes/rpc/host-gc-pass-registry.ts";

interface PassRegistry {
	readonly within: (path: string) => readonly string[];
	readonly settledWithin: (path: string) => Promise<void>;
}

interface RegistryHolder {
	current: PassRegistry;
}

// Every test file evaluates its own copy of the registry module, while `node:fs` is shared by the
// whole worker: the patch is installed once and always asks the current file's registry.
// After `vi.resetModules()`, a re-imported `host-gc-pass.ts` records its passes in a fresh registry this
// guard does not see; a test that resets modules and then calls `ensureHost` must join explicitly.
const HOLDER = Symbol.for("senpi.test.hostScratchRemovalGuard");

function isRegistryHolder(value: unknown): value is RegistryHolder {
	return typeof value === "object" && value !== null && "current" in value;
}

function pathOf(path: PathLike): string {
	return path instanceof URL ? fileURLToPath(path) : path.toString();
}

export function installHostScratchRemovalGuard(): void {
	const registry: PassRegistry = {
		within: opportunisticHostGcWithin,
		settledWithin: settledOpportunisticHostGcWithin,
	};
	const installed: unknown = Reflect.get(globalThis, HOLDER);
	if (isRegistryHolder(installed)) {
		installed.current = registry;
		return;
	}
	const holder: RegistryHolder = { current: registry };
	Reflect.set(globalThis, HOLDER, holder);
	const rm = fs.promises.rm;
	const rmSync = fs.rmSync;
	Object.defineProperty(fs.promises, "rm", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: async (path: PathLike, options?: RmOptions): Promise<void> => {
			await holder.current.settledWithin(pathOf(path));
			return rm(path, options);
		},
	});
	Object.defineProperty(fs, "rmSync", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: (path: PathLike, options?: RmOptions): void => {
			const pending = holder.current.within(pathOf(path));
			if (pending.length > 0)
				throw new Error(
					`rmSync(${pathOf(path)}) while ensureHost's gc pass for ${pending.join(", ")} is still writing into it (senpi#4382): await settledOpportunisticHostGc or removeHostScratch first`,
				);
			rmSync(path, options);
		},
	});
	syncBuiltinESMExports();
}
