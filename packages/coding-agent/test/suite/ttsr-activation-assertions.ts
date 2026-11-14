import { expect } from "vitest";

interface PersistedEntry {
	readonly type?: string;
	readonly customType?: string;
	readonly data?: unknown;
}

interface ExpectedActivation {
	readonly owner: string;
	readonly rules: readonly string[];
	readonly remediation: "nudge" | "provider-error";
}

export function expectTtsrActivation(entries: readonly PersistedEntry[], expected: ExpectedActivation): void {
	expect(entries).toContainEqual(
		expect.objectContaining({
			type: "custom",
			customType: "rule-activation",
			data: expect.objectContaining({
				kind: "ttsr",
				...expected,
			}),
		}),
	);
}
