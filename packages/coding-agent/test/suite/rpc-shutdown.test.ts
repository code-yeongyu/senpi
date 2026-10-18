import { expect, it } from "vitest";
import { createRpcShutdown } from "../../src/modes/rpc/shutdown.ts";

class ObservedExit extends Error {
	readonly code: number;
	constructor(code: number) {
		super(`exit ${code}`);
		this.code = code;
	}
}

// #1656: serializer failure and EOF must join, not bypass watcher disposal.
it.each([
	[1, 0],
	[0, 1],
])("joins reentrant shutdown and preserves failure (first=%s, second=%s)", async (firstCode, secondCode) => {
	// Given: the production RPC shutdown entry with disposal and process exit observed.
	const started = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let disposals = 0;
	let disposed = false;
	const exits: Array<{ code: number; disposed: boolean }> = [];
	const shutdown = createRpcShutdown(
		async () => {
			disposals++;
			started.resolve();
			await released.promise;
			disposed = true;
		},
		(code) => {
			exits.push({ code, disposed });
			throw new ObservedExit(code);
		},
	);
	const first = shutdown(firstCode);
	const firstOutcome = first.catch((error: unknown) => error);
	await started.promise;
	// When: the other shutdown source arrives before disposal completes.
	const second = shutdown(secondCode);
	const secondOutcome = second.catch((error: unknown) => error);
	const earlyExits = [...exits];
	released.resolve();
	const outcomes = await Promise.all([firstOutcome, secondOutcome]);
	// Then: both calls share one join and exactly one failure exit after disposal.
	expect(earlyExits).toEqual([]);
	expect(second).toBe(first);
	expect(disposals).toBe(1);
	expect(exits).toEqual([{ code: 1, disposed: true }]);
	for (const outcome of outcomes) expect(outcome).toMatchObject({ code: 1 });
});
