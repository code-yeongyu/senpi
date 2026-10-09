import { describe, expect, it } from "vitest";
import { classifyErrorMessage } from "../src/utils/retry.ts";

// Verbatim stream error captured from a real session (senpi#2376, 2026-09-29): a
// Claude subscription path answered some requests with this per-request rejection
// while the same credential served its neighbours; the next request usually passed.
const subscriptionForbiddenStreamError =
	'{"type":"error","error":{"type":"forbidden","message":"Request not allowed"}}';

describe("forbidden-without-reason rejections (senpi#2376)", () => {
	it.each([
		["stream error envelope", subscriptionForbiddenStreamError],
		["status-prefixed SDK shape", `403 ${subscriptionForbiddenStreamError}`],
		["message-first field order", '{"error":{"message":"Request not allowed.","type":"forbidden"}}'],
	])("retries the %s", (_label, message) => {
		expect(classifyErrorMessage(message)).toBe("retryable");
	});

	it.each([
		[
			"a permission_error that names the missing permission",
			'403 {"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}',
		],
		[
			"a forbidden rejection that carries a policy reason",
			'403 {"type":"error","error":{"type":"forbidden","message":"This organization has been disabled."}}',
		],
	])("keeps %s out of the retryable class", (_label, message) => {
		expect(classifyErrorMessage(message)).not.toBe("retryable");
	});
});
