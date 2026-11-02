import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const harness = join(import.meta.dirname, "rpc-internal-records-close-harness.ts");

// senpi#3816 review (HIGH): a peer that ends the hop while records wait behind backpressure must not lose them.
describe.skipIf(process.platform === "win32")("sealed hop end under backpressure", () => {
	for (const runtime of ["node", "bun"]) {
		it.each([100_000, 1_000_000])(
			`${runtime} delivers all %i bytes to a slow reader after the peer ends`,
			async (bytes) => {
				const { stdout } = await run(
					runtime,
					[...(runtime === "bun" ? [] : ["--import", "tsx"]), harness, String(bytes)],
					{ timeout: 60_000 },
				);
				expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({ received: bytes });
			},
			70_000,
		);
	}
});
