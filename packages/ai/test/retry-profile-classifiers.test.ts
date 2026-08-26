import { describe, expect, it } from "vitest";
import { isRetryableErrorMessage } from "../src/utils/retry.ts";
import { classifyKimiFailure, classifySenpiAssistantFailure } from "../src/utils/retry-profile/classifiers.ts";
import type { RetryFailure, RetryFailureKind } from "../src/utils/retry-profile/types.ts";

// Fixture strings below are mirrored verbatim from test/retry.test.ts, which
// declares them as module-private consts (it does not export them and must not
// be modified). Do not reword: the delegation pin intentionally matches the
// exact bytes today's regex classifier sees.
const apitopiaToolSchemaRejectionMessage =
	'500 data: {"error":{"message":"500 server_error: Invalid request: tools.function.parameters.type is required and must be \\"object\\"","type":"server_error","code":500,"status":500,"statusCode":500,"isRetryable":true}}\n\ndata:[DONE]\n\n';
const moonshotToolSchemaRejectionMessage =
	"500 server_error: Invalid request: tools.0.function.parameters: invalid tool schema";
const anthropicInvalidMaxTokensMessage =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than or equal to 1"}}';
const anthropicCreditsRequiredMessage =
	'429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","model":"claude-fable-5"}},"request_id":"req_011CdW2nFxprAx6KQ9JhnAvq"}';
const gatewayModelRequestRejectedMessage = "Error: The model request was rejected. Check the request and try again.";
const openAIExplicitRetryMessage =
	"An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID req_******** in your message.";
const openAIServerErrorMessage =
	"Error: Error Code server_error: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID e4026cfc-c6b6-414a-8a21-c03a6adf0336 in your message.";
const bedrockExplicitRetryMessage =
	'{"message":"The system encountered an unexpected error during processing. Try your request again."}';
const nvidiaNIMResourceExhaustedMessage = "ResourceExhausted: Worker local total request limit reached (288/48)";
const bunFetchSocketClosedMessage =
	"The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()";
const openAIResponsesEarlyEofMessage = "OpenAI Responses stream ended before a terminal response event";
const wrappedDnsLookupError =
	"The pending stream has been canceled (caused by: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com)";
const anthropicOrphanServerToolMessage =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: `web_search` tool use with id `srvtoolu_01Gchdhqw1UaCNUuVq2LhMH9` was found without a corresponding `web_search_tool_result` block"},"request_id":"req_011CdQL9JsEk5NWJxWQX4NiG"}';

const kimiFailure = (kind: RetryFailureKind, extra: Partial<RetryFailure> = {}): RetryFailure => ({
	origin: "kimi-test",
	kind,
	message: "kimi failure",
	...extra,
});

describe("classifyKimiFailure", () => {
	it.each([
		[408, "transient"],
		[409, "transient"],
		[429, "rate-limited"],
		[500, "transient"],
		[502, "transient"],
		[503, "transient"],
		[504, "transient"],
		[529, "transient"],
	] as const)("classifies whitelisted http-status %i as %s", (statusCode, verdict) => {
		expect(classifyKimiFailure(kimiFailure("http-status", { statusCode }))).toEqual({ verdict });
	});

	it.each([400, 401, 404, 422, 501] as const)(
		"classifies non-whitelisted http-status %i as terminal",
		(statusCode) => {
			expect(classifyKimiFailure(kimiFailure("http-status", { statusCode }))).toEqual({
				verdict: "terminal",
			});
		},
	);

	it("classifies an http-status failure without a status code as terminal", () => {
		expect(classifyKimiFailure(kimiFailure("http-status"))).toEqual({ verdict: "terminal" });
	});

	it.each([
		["abort", "terminal"],
		["refusal", "terminal"],
		["sensitive", "terminal"],
		["connection", "transient"],
		["timeout", "transient"],
		["quota-exhausted", "terminal"],
		["image-format", "terminal"],
		["provider", "transient"],
		["unknown", "terminal"],
	] as const)("classifies %s failures as %s", (kind, verdict) => {
		expect(classifyKimiFailure(kimiFailure(kind))).toEqual({ verdict });
	});

	it("classifies empty-response as transient unless the finish reason is filtered", () => {
		expect(classifyKimiFailure(kimiFailure("empty-response"))).toEqual({ verdict: "transient" });
		expect(classifyKimiFailure(kimiFailure("empty-response", { finishReason: "stop" }))).toEqual({
			verdict: "transient",
		});
		expect(classifyKimiFailure(kimiFailure("empty-response", { finishReason: "filtered" }))).toEqual({
			verdict: "terminal",
		});
	});

	it("classifies quota-exhausted 429 as terminal (kind outranks the whitelisted status)", () => {
		expect(classifyKimiFailure(kimiFailure("quota-exhausted", { statusCode: 429 }))).toEqual({
			verdict: "terminal",
		});
	});
});

describe("classifySenpiAssistantFailure", () => {
	it.each([
		["apitopia tool-schema rejection in a 500 envelope", apitopiaToolSchemaRejectionMessage, false],
		["moonshot tool-schema rejection in a 500 envelope", moonshotToolSchemaRejectionMessage, false],
		["anthropic invalid max_tokens 400", anthropicInvalidMaxTokensMessage, false],
		["429 quota exceeded", "429 quota exceeded", false],
		["anthropic credits_required 429", anthropicCreditsRequiredMessage, false],
		["canonical gateway model-request rejection", gatewayModelRequestRejectedMessage, true],
		["openai explicit retry guidance", openAIExplicitRetryMessage, true],
		["openai server_error with retry guidance", openAIServerErrorMessage, true],
		["bedrock explicit retry guidance", bedrockExplicitRetryMessage, true],
		["nvidia nim ResourceExhausted", nvidiaNIMResourceExhaustedMessage, true],
		["bun fetch socket drop", bunFetchSocketClosedMessage, true],
		["openai responses early EOF", openAIResponsesEarlyEofMessage, true],
		["wrapped DNS lookup failure", wrappedDnsLookupError, true],
		["anthropic orphan server-tool 400", anthropicOrphanServerToolMessage, true],
	])("mirrors isRetryableErrorMessage: %s", (_label, message, retryable) => {
		const failure: RetryFailure = { origin: "senpi-assistant-test", kind: "unknown", message };
		// Pin the fixture's expected boolean first so regex drift surfaces here too.
		expect(isRetryableErrorMessage(message)).toBe(retryable);
		expect(classifySenpiAssistantFailure(failure)).toEqual(
			retryable ? { verdict: "transient" } : { verdict: "terminal" },
		);
	});

	it("keeps non-retryable precedence over retryable wording, matching the regexes", () => {
		for (const message of [
			`${gatewayModelRequestRejectedMessage} quota exceeded`,
			`${gatewayModelRequestRejectedMessage} Invalid request: tools.0.function.parameters.type is required`,
		]) {
			const failure: RetryFailure = { origin: "senpi-assistant-test", kind: "unknown", message };
			expect(isRetryableErrorMessage(message)).toBe(false);
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		}
	});

	// ACCEPTED DIVERGENCE (required by the source policy): a Kimi 500 whose body
	// carries senpi's invalid-tool-schema text is RETRYABLE under the Kimi status
	// classifier (the whitelisted 500 alone decides that stage) but TERMINAL under
	// senpi's message classifier (its non-retryable request-shape patterns take
	// precedence over any status or retry wording). Both verdicts are correct for
	// their own stage; the classifier contract keeps the policies independent.
	it("pins the accepted divergence between the two classifiers on a tool-schema 500", () => {
		const failure: RetryFailure = {
			origin: "divergence-test",
			kind: "http-status",
			statusCode: 500,
			message: moonshotToolSchemaRejectionMessage,
		};
		expect(classifyKimiFailure(failure)).toEqual({ verdict: "transient" });
		expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
	});

	describe("structured status consulted only when the regexes are unknown", () => {
		const opaqueFailure = (extra: Partial<RetryFailure>): RetryFailure => ({
			origin: "senpi-assistant-test",
			kind: "http-status",
			message: "The provider could not complete this request right now",
			...extra,
		});

		it.each([408, 409, 500, 502, 503, 504, 522, 524] as const)(
			"retries an opaque %i on its structured status alone",
			(statusCode) => {
				const failure = opaqueFailure({ statusCode });
				expect(isRetryableErrorMessage(failure.message)).toBe(false);
				expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "transient" });
			},
		);

		it("classifies an opaque 429 as rate-limited on its structured status alone", () => {
			const failure = opaqueFailure({ statusCode: 429 });
			expect(isRetryableErrorMessage(failure.message)).toBe(false);
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "rate-limited" });
		});

		it("keeps 529 retryable for an opaque message", () => {
			const failure = opaqueFailure({ statusCode: 529 });
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "transient" });
		});

		it("treats a 429 with insufficient_quota provider code as terminal", () => {
			const failure = opaqueFailure({ statusCode: 429, providerCodes: ["insufficient_quota"] });
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		});

		it("treats a 429 with credits_required provider code as terminal", () => {
			const failure = opaqueFailure({ statusCode: 429, providerCodes: ["credits_required"] });
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		});

		it("honours a structured shouldRetry:false over a whitelisted status", () => {
			const failure = opaqueFailure({ statusCode: 503, shouldRetry: false });
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		});

		it("keeps a 500 carrying tool-schema text terminal (non-retryable regex outranks status)", () => {
			const failure: RetryFailure = {
				origin: "senpi-assistant-test",
				kind: "http-status",
				statusCode: 500,
				message: moonshotToolSchemaRejectionMessage,
			};
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		});

		it("keeps a 400 carrying server-tool pairing text retryable (retryable regex outranks status)", () => {
			const failure: RetryFailure = {
				origin: "senpi-assistant-test",
				kind: "http-status",
				statusCode: 400,
				message: anthropicOrphanServerToolMessage,
			};
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "transient" });
		});

		it("falls back to the exact regex verdict when no diagnostic facts exist", () => {
			const failure: RetryFailure = {
				origin: "senpi-assistant-test",
				kind: "unknown",
				message: "The provider could not complete this request right now",
			};
			expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
		});

		it("keeps deterministic failure kinds terminal before any text or status inspection", () => {
			for (const kind of ["abort", "refusal", "sensitive", "quota-exhausted", "image-format"] as const) {
				const failure: RetryFailure = {
					origin: "senpi-assistant-test",
					kind,
					statusCode: 503,
					message: "overloaded",
				};
				expect(classifySenpiAssistantFailure(failure)).toEqual({ verdict: "terminal" });
			}
		});
	});
});
