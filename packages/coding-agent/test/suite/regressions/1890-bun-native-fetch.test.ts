import { describe, expect, it } from "vitest";
import { shouldInstallUndiciGlobals } from "../../../src/core/http-dispatcher.ts";

/**
 * Pure decision behind `configureHttpDispatcher`'s global install (#1890).
 * Nothing here touches the real dispatcher or the host runtime: the facts are
 * injected so the Node and Bun branches are both reachable from one runner.
 */
const NODE_VERSIONS = { node: "24.0.0" } as const;
const BUN_VERSIONS = { node: "24.0.0", bun: "1.3.14" } as const;

const originalFetch = () => undefined;
const overriddenFetch = () => undefined;
const installedFetch = () => undefined;

describe("shouldInstallUndiciGlobals", () => {
	describe("#given Node", () => {
		it("installs on a first call while the runtime fetch is untouched", () => {
			expect(
				shouldInstallUndiciGlobals({
					versions: NODE_VERSIONS,
					currentFetch: originalFetch,
					originalFetch,
					installedFetch: undefined,
				}),
			).toBe(true);
		});

		it("preserves a fetch a caller replaced before the first call", () => {
			expect(
				shouldInstallUndiciGlobals({
					versions: NODE_VERSIONS,
					currentFetch: overriddenFetch,
					originalFetch,
					installedFetch: undefined,
				}),
			).toBe(false);
		});

		it("reinstalls on a later call while the installed fetch is still in place", () => {
			expect(
				shouldInstallUndiciGlobals({
					versions: NODE_VERSIONS,
					currentFetch: installedFetch,
					originalFetch,
					installedFetch,
				}),
			).toBe(true);
		});

		it("preserves a fetch a caller replaced after an earlier install", () => {
			expect(
				shouldInstallUndiciGlobals({
					versions: NODE_VERSIONS,
					currentFetch: overriddenFetch,
					originalFetch,
					installedFetch,
				}),
			).toBe(false);
		});
	});

	describe("#given Bun", () => {
		it("never replaces Bun's native fetch, even on a first untouched call", () => {
			expect(
				shouldInstallUndiciGlobals({
					versions: BUN_VERSIONS,
					currentFetch: originalFetch,
					originalFetch,
					installedFetch: undefined,
				}),
			).toBe(false);
		});
	});
});
