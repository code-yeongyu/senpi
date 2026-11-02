import { describe, expect, it, vi } from "vitest";
import { processExitEvent } from "../../helpers/process-exit-event.ts";

// #3054: POSIX exit observation must fail, not skip, when its native compiler is absent.
describe.skipIf(process.platform !== "darwin" && process.platform !== "linux")("exit waiter compiler", () => {
	it("names missing cc and can compile again once PATH is restored", async () => {
		vi.stubEnv("PATH", "");
		try {
			await expect(processExitEvent(process.pid)).rejects.toThrow("Missing C compiler 'cc' on PATH");
		} finally {
			vi.unstubAllEnvs();
		}
		const event = await processExitEvent(process.pid);
		await event.dispose();
	});
});
