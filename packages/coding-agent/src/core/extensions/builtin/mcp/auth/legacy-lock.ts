import { open, rm, stat } from "node:fs/promises";
import { safeDelay } from "../wrap.ts";

/** Shares the existing O_EXCL file with synchronous migrators without blocking the event loop. */
export async function acquireLegacyLock(path: string, stale: number): Promise<() => Promise<void>> {
	const deadline = Date.now() + stale;
	for (;;) {
		try {
			const file = await open(path, "wx", 0o600);
			return async () => {
				try {
					await file.close();
				} finally {
					await rm(path, { force: true });
				}
			};
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
			try {
				const age = Date.now() - (await stat(path)).mtimeMs;
				if (age >= stale) {
					await rm(path, { force: true });
					continue;
				}
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
				throw error;
			}
			if (Date.now() >= deadline) throw new Error("Legacy OAuth migration lock acquisition timed out");
			await safeDelay(20);
		}
	}
}
