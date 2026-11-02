import { describe, expect, it } from "vitest";
import { readProviderDiagnostic, sanitizeProviderDiagnostic } from "../src/provider-diagnostic.ts";
import { attachProviderDiagnostic } from "../src/utils/provider-diagnostic-carrier.ts";

// senpi#2197: a diagnostic that crossed a boundary is revalidated against the closed mapping.

describe("sanitizeProviderDiagnostic", () => {
	it("returns a fresh canonical copy of a valid diagnostic without extra keys", () => {
		const input = {
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
			message: "leaked text",
		};
		const output = sanitizeProviderDiagnostic(input);
		expect(output).toEqual({
			category: "rate_limit",
			httpStatus: 429,
			code: "rate_limit_error",
			evidence: "structured_code",
		});
		expect(output).not.toBe(input);
	});

	it.each([
		["non-object", "auth"],
		["unknown category", { category: "teapot", httpStatus: 418, evidence: "structured_status" }],
		[
			"category disagreeing with the code",
			{ category: "quota", code: "rate_limit_error", evidence: "structured_code" },
		],
		["code not in the allowlist", { category: "unknown", code: "sk-ant-secret", evidence: "structured_code" }],
		["status out of range", { category: "unknown", httpStatus: 200, evidence: "structured_status" }],
		[
			"status evidence carrying a code",
			{ category: "auth", httpStatus: 401, code: "authentication_error", evidence: "structured_status" },
		],
		[
			"status disagreeing with the code",
			{ category: "auth", httpStatus: 500, code: "authentication_error", evidence: "structured_code" },
		],
		[
			"status evidence disagreeing with the status family",
			{ category: "auth", httpStatus: 503, evidence: "structured_status" },
		],
		["unknown evidence", { category: "auth", httpStatus: 401, evidence: "message_text" }],
	])("drops %s", (_label, value) => {
		expect(sanitizeProviderDiagnostic(value)).toBeUndefined();
	});

	it("survives a throwing getter", () => {
		const hostile = {
			get category(): string {
				throw new Error("boom");
			},
		};
		expect(sanitizeProviderDiagnostic(hostile)).toBeUndefined();
	});
});

describe("readProviderDiagnostic", () => {
	it("reads only the adapter carrier, never a self-declared property", () => {
		const selfDeclared = Object.assign(new Error("x"), {
			providerDiagnostic: { category: "auth", httpStatus: 401, evidence: "structured_status" },
		});
		expect(readProviderDiagnostic(selfDeclared)).toBeUndefined();

		const carried = attachProviderDiagnostic(new Error("y"), {
			category: "auth",
			httpStatus: 401,
			evidence: "structured_status",
		});
		expect(readProviderDiagnostic(carried)).toEqual({
			category: "auth",
			httpStatus: 401,
			evidence: "structured_status",
		});
		expect(readProviderDiagnostic("not an object")).toBeUndefined();
	});
});
