import { vi } from "vitest";

const inject = vi.hoisted(() => ({
	/** errno code removing a socket secret staging file fails with. */
	unlinkStaging: undefined as string | undefined,
	/** Whether fsync of any directory fails with EIO. */
	syncDirectories: false,
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
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (inject.syncDirectories && (await handle.stat()).isDirectory()) {
				handle.sync = async () => {
					throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO", syscall: "fsync" });
				};
			}
			return handle;
		},
	};
});

import { afterEach, describe, expect, it } from "vitest";
import { socketSecretPath } from "../../../src/modes/rpc/socket-transport.ts";
import { type EndpointFixture, startEndpoint } from "../../helpers/session-control-fixture.ts";

// Regression coverage for https://github.com/sisyphuslabs/omo-desktop-app/issues/4199 (review LOW on senpi#6437): the
// interactive TUI publishes its control endpoint's socket secret, and a warning about that publication is shown in the
// TUI through its notice line, never written to stderr underneath the TUI frame.
describe.skipIf(process.platform === "win32")("socket secret warnings in the interactive TUI", () => {
	let fixture: EndpointFixture | undefined;

	afterEach(async () => {
		inject.unlinkStaging = undefined;
		inject.syncDirectories = false;
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

	it("names the secret path in the notice for a directory fsync failure", async () => {
		inject.syncDirectories = true;
		const started = await startEndpoint();
		fixture = started;
		expect(started.notices.filter((notice) => notice.includes("socket secret"))).toEqual([
			expect.stringMatching(
				/directory fsync failed after publishing \(SENPI_RPC_SOCKET_SECRET_DIRECTORY_SYNC_FAILED\)/,
			),
		]);
		expect(started.notices.some((notice) => notice.includes(socketSecretPath(started.socket)))).toBe(true);
	});

	it("names the staging file path in the notice for a staging cleanup failure", async () => {
		inject.unlinkStaging = "EBUSY";
		fixture = await startEndpoint();
		const notice = fixture.notices.find((entry) => entry.includes("staging file was not removed"));
		expect(notice).toMatch(/\.secret\.stage-/);
	});
});
