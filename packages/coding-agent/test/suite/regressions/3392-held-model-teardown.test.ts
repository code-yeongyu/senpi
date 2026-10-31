import { once } from "node:events";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { HeldAnthropicModel } from "../../helpers/rpc-generation-support.ts";

// #3392: teardown must not wait for the host to close a response the fixture itself is withholding.
describe("held RPC model teardown", () => {
	it("finishes an accepted held request when cleanup runs before release", async ({ signal }) => {
		const model = await HeldAnthropicModel.start();
		const body = new Promise<string>((resolve, reject) => {
			const req = request(model.origin, { method: "POST" }, (res) => {
				let text = "";
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					text += chunk;
				});
				res.once("end", () => resolve(text));
				res.once("error", reject);
			});
			req.once("error", reject);
			req.end("{}");
		});
		// Register and observe the actual HTTP request, not an elapsed-time guess about provider startup.
		await model.requested;
		const stop = new AbortController();
		const aborted = once(signal, "abort", { signal: stop.signal }).then(() => {
			throw new Error("held model close did not finish before the test ended");
		});
		try {
			await Promise.race([model.close(), aborted]);
			expect(await body).toContain("held turn complete");
		} finally {
			stop.abort();
			// The RED run must also leave no socket or request behind.
			model.release();
			await body;
			await model.close();
		}
	}, 10_000);
});
