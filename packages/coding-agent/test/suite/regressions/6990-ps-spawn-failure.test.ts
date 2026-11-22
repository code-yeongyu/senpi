import { describe, expect, it, vi } from "vitest";

/**
 * senpi#6990 L2: the darwin-on-Node `ps` reader must hold this module's never-throw contract when the spawn itself
 * fails — EPERM was reproduced, EAGAIN is possible under process-table pressure. `execFile` throws synchronously in
 * that case, inside the Promise executor, so `readKernelProcessIdentity` (and with it `resolvePidSession`, whose own
 * doc says "Never throws") used to reject. The mock stands in for the failed spawn before the module under test
 * imports `execFile`; an unreadable pid must read as unidentified, not as a rejection.
 */
vi.mock("node:child_process", () => ({
	execFile: () => {
		throw new Error("spawn EPERM (mocked: the ps spawn failed before a child existed)");
	},
}));

import { darwinPsIdentity } from "../../../src/core/kernel-process-identity.ts";

describe("darwin ps identity when the spawn itself fails (#6990)", () => {
	it("resolves undefined instead of rejecting when execFile throws synchronously", async () => {
		await expect(darwinPsIdentity(4242)).resolves.toBe(undefined);
	});
});
