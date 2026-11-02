import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { cleanupRuntime } from "../../scripts/gate-runtime-cleanup.ts";

it.each(["kernel", "bridge", "observer", "none"] as const)(
	"retires independent resources after %s cleanup",
	async (failure) => {
		// Given: a real listening bridge and temporary root, with a lifecycle failure.
		const root = await mkdtemp(join(tmpdir(), "senpi-gate-cleanup-"));
		const server = createServer();
		const ready = once(server, "listening");
		server.listen(0, "127.0.0.1");
		await ready;
		const original = new Error("fixture retirement failure");
		let restored = false;
		const close = async () => {
			if (!server.listening) return;
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		};
		try {
			// When: any one cleanup operation fails, all other operations are still required.
			let reported: unknown;
			try {
				await cleanupRuntime({
					retireKernel: async () => {
						if (failure === "kernel") throw original;
					},
					closeBridge: async () => {
						await close();
						if (failure === "bridge") throw original;
					},
					restoreObservers: () => {
						restored = true;
						if (failure === "observer") throw original;
					},
					removeRoot: () => rm(root, { recursive: true, force: true }),
				});
			} catch (error) {
				reported = error;
			}
			// Then: cleanup completes and preserves the original failure instead of hiding it.
			expect(server.listening).toBe(false);
			expect(restored).toBe(true);
			await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
			if (failure === "none") expect(reported).toBeUndefined();
			else {
				expect(reported).toBeInstanceOf(AggregateError);
				if (!(reported instanceof AggregateError)) throw new TypeError("Missing cleanup failure");
				expect(reported.errors).toContain(original);
				expect(reported.message).toContain(original.message);
			}
		} finally {
			await close();
			await rm(root, { recursive: true, force: true });
		}
	},
);

it("keeps the root and observers until kernel and bridge shutdown settle", async () => {
	const retiring = Promise.withResolvers<void>();
	const closing = Promise.withResolvers<void>();
	const started = Promise.withResolvers<void>();
	let restored = false;
	let removed = false;
	const cleanup = cleanupRuntime({
		retireKernel: async () => {
			started.resolve();
			await retiring.promise;
		},
		closeBridge: () => closing.promise,
		restoreObservers: () => {
			restored = true;
		},
		removeRoot: async () => {
			removed = true;
		},
	});
	try {
		await started.promise;
		expect(restored).toBe(false);
		expect(removed).toBe(false);
		closing.resolve();
		expect(removed).toBe(false);
	} finally {
		retiring.resolve();
		closing.resolve();
		await cleanup;
	}
	expect(restored).toBe(true);
	expect(removed).toBe(true);
});
