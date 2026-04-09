import { describe, expect, it } from "vitest";
import { resolveContinuationConfig } from "../../src/core/extensions/builtin/todotools/continuation/config.js";

function createSettings(enabled: unknown): Record<string, unknown> {
	return {
		todotools: {
			continuation: {
				enabled,
			},
		},
	};
}

describe("resolveContinuationConfig", () => {
	it("defaults to enabled when settings and flag are absent", () => {
		expect(resolveContinuationConfig({})).toEqual({ enabled: true });
	});

	it("disables continuation when global settings enable path is false", () => {
		expect(
			resolveContinuationConfig({
				globalSettings: createSettings(false),
			}),
		).toEqual({ enabled: false });
	});

	it("lets project false override global true", () => {
		expect(
			resolveContinuationConfig({
				globalSettings: createSettings(true),
				projectSettings: createSettings(false),
			}),
		).toEqual({ enabled: false });
	});

	it("lets project true override global false", () => {
		expect(
			resolveContinuationConfig({
				globalSettings: createSettings(false),
				projectSettings: createSettings(true),
			}),
		).toEqual({ enabled: true });
	});

	it("lets the cli flag force-disable continuation", () => {
		expect(
			resolveContinuationConfig({
				globalSettings: createSettings(false),
				projectSettings: createSettings(true),
				cliFlag: true,
			}),
		).toEqual({ enabled: false });
	});

	it("treats only a strict true cli flag as disable", () => {
		const nonDisablingFlags: unknown[] = [undefined, false, "true", "false", 0, 1, {}, []];

		for (const cliFlag of nonDisablingFlags) {
			expect(
				resolveContinuationConfig({
					globalSettings: createSettings(true),
					projectSettings: createSettings(false),
					cliFlag,
				}),
			).toEqual({ enabled: false });
		}
	});

	it("ignores non-boolean settings values and preserves the default", () => {
		const invalidValues: unknown[] = ["true", "false", null, 0, 1, {}, []];

		for (const invalidValue of invalidValues) {
			expect(
				resolveContinuationConfig({
					globalSettings: createSettings(invalidValue),
				}),
			).toEqual({ enabled: true });

			expect(
				resolveContinuationConfig({
					projectSettings: createSettings(invalidValue),
				}),
			).toEqual({ enabled: true });
		}
	});

	it("reads only the todotools.continuation.enabled path", () => {
		const flatMisnamed: Record<string, unknown> = {
			todotools: {
				continuationEnabled: false,
			},
		};
		const alternateNamespace: Record<string, unknown> = {
			todoContinuation: {
				enabled: false,
			},
		};

		expect(
			resolveContinuationConfig({
				globalSettings: flatMisnamed,
			}),
		).toEqual({ enabled: true });

		expect(
			resolveContinuationConfig({
				globalSettings: alternateNamespace,
			}),
		).toEqual({ enabled: true });

		expect(
			resolveContinuationConfig({
				globalSettings: createSettings(false),
			}),
		).toEqual({ enabled: false });
	});

	it("implements the full global/project truth table without a cli flag", () => {
		const cases: Array<{
			globalEnabled: boolean | undefined;
			projectEnabled: boolean | undefined;
			expected: boolean;
		}> = [
			{ globalEnabled: undefined, projectEnabled: undefined, expected: true },
			{ globalEnabled: undefined, projectEnabled: true, expected: true },
			{ globalEnabled: undefined, projectEnabled: false, expected: false },
			{ globalEnabled: true, projectEnabled: undefined, expected: true },
			{ globalEnabled: true, projectEnabled: true, expected: true },
			{ globalEnabled: true, projectEnabled: false, expected: false },
			{ globalEnabled: false, projectEnabled: undefined, expected: false },
			{ globalEnabled: false, projectEnabled: true, expected: true },
			{ globalEnabled: false, projectEnabled: false, expected: false },
		];

		for (const { globalEnabled, projectEnabled, expected } of cases) {
			expect(
				resolveContinuationConfig({
					globalSettings: globalEnabled === undefined ? undefined : createSettings(globalEnabled),
					projectSettings: projectEnabled === undefined ? undefined : createSettings(projectEnabled),
				}),
			).toEqual({ enabled: expected });
		}
	});
});
