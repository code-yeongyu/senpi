import { vi } from "vitest";

const inject = vi.hoisted(() => ({
	/** errno code removing a socket secret staging file fails with. */
	unlinkStaging: undefined as string | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		unlink: async (...args: Parameters<typeof actual.unlink>) => {
			if (inject.unlinkStaging !== undefined && String(args[0]).includes(".secret.stage-")) {
				throw Object.assign(new Error(`${inject.unlinkStaging}: injected unlink failure`), {
					code: inject.unlinkStaging,
					syscall: "unlink",
				});
			}
			return actual.unlink(...args);
		},
	};
});

import { afterEach, describe, expect, it } from "vitest";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (review LOW on senpi#6437): the
// interactive TUI publishes its control endpoint's socket secret, and a warning about that publication is shown in the
// TUI through its notice line, never written to stderr underneath the TUI frame.
describe.skipIf(process.platform === "win32")("socket secret warnings in the interactive TUI", () => {
	let fixture: EndpointFixture | undefined;

	afterEach(async () => {
		inject.unlinkStaging = undefined;
		vi.restoreAllMocks();
		await fixture?.endpoint.dispose();
		fixture?.harness.cleanup();
		fixture = undefined;
	});

	it("shows a staging cleanup failure as a TUI notice and writes nothing to stderr", async () => {
		const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
		const stderr = vi.spyOn(process.stderr, "write");
		inject.unlinkStaging = "EBUSY";
		fixture = await startEndpoint();
		expect(emitWarning).not.toHaveBeenCalled();
		expect(stderr.mock.calls.filter((call) => String(call[0]).includes("socket secret"))).toEqual([]);
		expect(fixture.notices.filter((notice) => notice.includes("socket secret"))).toEqual([
			expect.stringMatching(
				/socket secret staging file was not removed \(SENPI_RPC_SOCKET_SECRET_STAGING_LEFT_BEHIND\).*EBUSY/,
			),
		]);
	});
});
