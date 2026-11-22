import { describe, expect, it } from "vitest";
import { classifyCredentialFailure } from "../../../src/core/credential-pool/classify.ts";
import { usageLimitResetMs } from "../../../src/core/credential-pool/reset-time.ts";

const NOW_MS = Date.UTC(2026, 10, 3, 0, 24, 0);
const RESET_MS = Date.UTC(2026, 10, 3, 2, 40, 2);

describe("#5596 a usage limit that names its reset as an ISO timestamp", () => {
	it.each([
		"Weekly usage limit reached. Resets at 2026-11-03T02:40:02Z",
		"Weekly usage limit reached. Resets at 2026-11-03T02:40:02.000Z",
		"Weekly usage limit reached. Resets at 2026-11-03T11:40:02+09:00",
		"Weekly usage limit reached. resets 2026-11-03T02:40:02Z.",
	])("reads the reset from %s", (text) => {
		expect(usageLimitResetMs(text, NOW_MS)).toBe(RESET_MS - NOW_MS);
	});

	it("blocks the account until that reset instead of the 60 s rate-limit backoff", () => {
		const error = Object.assign(
			new Error(
				'429 {"type":"error","error":{"type":"rate_limit_error","message":"Weekly usage limit reached. Resets at 2026-11-03T02:40:02Z"}}',
			),
			{ status: 429 },
		);

		const action = classifyCredentialFailure(error, { nowMs: NOW_MS });

		expect(action).toMatchObject({ kind: "failover", block: { reason: "rate_limit" } });
		if (action.kind !== "failover" || action.block.reason !== "rate_limit") throw new Error("not a rate-limit block");
		expect(action.block.cooldownMs).toBe(RESET_MS - NOW_MS);
	});

	it("ignores an ISO timestamp that is not introduced as a reset", () => {
		expect(usageLimitResetMs("Weekly usage limit reached at 2026-11-03T02:40:02Z", NOW_MS)).toBeUndefined();
	});
});
