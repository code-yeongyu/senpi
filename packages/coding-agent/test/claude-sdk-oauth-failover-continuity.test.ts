import { describe, expect, it } from "vitest";
import {
	decideFailoverContinuity,
	type FailoverContinuityInput,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";

function input(overrides: Partial<FailoverContinuityInput> = {}): FailoverContinuityInput {
	return {
		authLane: "oauth-slots",
		crossAccountResumeSupported: true,
		entry: { sdkSessionId: "sdk-1", sentCount: 3, lastAssistantUuid: "uuid-a3" },
		...overrides,
	};
}

describe("claude-sdk-oauth failover continuity", () => {
	it("reattaches under the new account when a shared root supports cross-account resume", () => {
		expect(decideFailoverContinuity(input())).toMatchObject({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 3,
		});
	});

	it("reattaches on the ambient lane too, which shares the default config root", () => {
		expect(decideFailoverContinuity(input({ authLane: "ambient" }))).toMatchObject({ kind: "reattach" });
	});

	it("forks at the last verified boundary when the shared root denies cross-account resume", () => {
		expect(decideFailoverContinuity(input({ crossAccountResumeSupported: false }))).toMatchObject({
			kind: "fork",
			sdkSessionId: "sdk-1",
			atUuid: "uuid-a3",
			from: 3,
		});
	});

	it("flattens on the config-dir lane, the one declared cross-root residual", () => {
		expect(decideFailoverContinuity(input({ authLane: "config-dir" }))).toEqual({
			kind: "flatten",
			reason: "cross_root_unsupported",
		});
	});

	it("still flattens on config-dir even when cross-account resume is otherwise supported", () => {
		expect(
			decideFailoverContinuity(input({ authLane: "config-dir", crossAccountResumeSupported: true })),
		).toMatchObject({ kind: "flatten", reason: "cross_root_unsupported" });
	});

	it("never flattens on a shared-root lane while a boundary exists", () => {
		const kinds = [
			decideFailoverContinuity(input({ crossAccountResumeSupported: true })).kind,
			decideFailoverContinuity(input({ crossAccountResumeSupported: false })).kind,
			decideFailoverContinuity(input({ authLane: "ambient", crossAccountResumeSupported: false })).kind,
		];

		expect(kinds).not.toContain("flatten");
	});

	it("falls back to flatten only when a shared-root lane has no boundary to fork at", () => {
		const decision = decideFailoverContinuity(
			input({
				crossAccountResumeSupported: false,
				entry: { sdkSessionId: "sdk-1", sentCount: 0, lastAssistantUuid: null },
			}),
		);

		expect(decision).toMatchObject({ kind: "flatten", reason: "branch_boundary_unavailable" });
	});
});
