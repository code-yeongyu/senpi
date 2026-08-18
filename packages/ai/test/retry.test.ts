import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import {
	isProviderStreamStallError,
	isProviderTimeoutError,
	isRetryableAssistantError,
	type RetryPolicy,
	retryAssistantCall,
} from "../src/utils/retry.ts";

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
const codexUpstreamUnavailableMessage =
	"Error: upstream_unavailable: Codex upstream websocket send failed via proxy endpoint unknown: ConnectionClosedOK";
const anthropicOrphanServerToolMessage =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.1: `web_search` tool use with id `srvtoolu_01Gchdhqw1UaCNUuVq2LhMH9` was found without a corresponding `web_search_tool_result` block"},"request_id":"req_011CdQL9JsEk5NWJxWQX4NiG"}';
const anthropicInvalidMaxTokensMessage =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"max_tokens: must be greater than or equal to 1"}}';
const apitopiaToolSchemaRejectionMessage =
	'500 data: {"error":{"message":"500 server_error: Invalid request: tools.function.parameters.type is required and must be \\"object\\"","type":"server_error","code":500,"status":500,"statusCode":500,"isRetryable":true}}\n\ndata:[DONE]\n\n';
const moonshotToolSchemaRejectionMessage =
	"500 server_error: Invalid request: tools.0.function.parameters: invalid tool schema";
const gatewayModelRequestRejectedMessage = "Error: The model request was rejected. Check the request and try again.";
const nonCanonicalModelRequestRejectionMessages = [
	"Error: The model request was rejected because this API key does not have permission to use it.",
	"Error: The model request was rejected because max_tokens must be greater than or equal to 1.",
	"Error: The model request was rejected by the safety classifier.",
] as const;

describe("provider retry classification", () => {
	it("matches explicit provider retry guidance", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bedrockExplicitRetryMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: nvidiaNIMResourceExhaustedMessage }),
			),
		).toBe(true);
	});

	it("classifies agent-loop stream timeout errors as retryable", () => {
		// Wordings produced by packages/agent/src/agent-loop.ts; the "timed out"
		// coupling is what lets a dead stream start retry instead of dead-ending
		// the session.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stream start timed out after 90000ms",
				}),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Idle timeout waiting for provider stream after 300000ms",
				}),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Provider stream never started" }),
			),
		).toBe(false);
	});

	it.each([
		["Idle timeout waiting for provider stream after 300000ms", true, true],
		["Provider stream start timed out after 90000ms", true, true],
		["Request timed out.", false, true],
		["Request timed out", false, true],
		["Command timed out after 30000ms", false, false],
		["MCP server example timed out", false, false],
		["extension timed out", false, false],
	] as const)(
		"classifies provider timeout provenance without matching incidental text: %s",
		(errorMessage, expectedStall, expectedTimeout) => {
			const message = fauxAssistantMessage("", { stopReason: "error", errorMessage });
			expect(isProviderStreamStallError(message)).toBe(expectedStall);
			expect(isProviderTimeoutError(message)).toBe(expectedTimeout);
		},
	);

	it("recognizes aborted transport timeouts but not unrelated aborted work", () => {
		expect(
			isProviderTimeoutError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request timed out." }),
			),
		).toBe(true);
		expect(
			isProviderTimeoutError(
				fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Command timed out after 30000ms" }),
			),
		).toBe(false);
		expect(
			isProviderStreamStallError(
				fauxAssistantMessage("", {
					stopReason: "aborted",
					errorMessage: "Idle timeout waiting for provider stream after 300000ms",
				}),
			),
		).toBe(false);
	});

	it("classifies the observed OpenAI server_error as retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIServerErrorMessage }),
			),
		).toBe(true);
	});

	it("classifies Cloudflare 522 connection timeouts as retryable", () => {
		// Cloudflare emits "Error: error code: 522" (Connection timed out) when the
		// origin stops responding; like the other 5xx gateway statuses already in the
		// pattern list, it is transient and must go through the bounded retry policy.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Error: error code: 522" }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "522: Connection timed out" }),
			),
		).toBe(true);
	});

	it("matches Bun fetch socket drop wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: bunFetchSocketClosedMessage }),
			),
		).toBe(true);
	});

	it("matches Codex upstream websocket unavailability", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: codexUpstreamUnavailableMessage }),
			),
		).toBe(true);
	});

	it("classifies zero-event stream idle timeouts as provider stream stalls", () => {
		// Stall retries replay the identical payload against a provider that
		// already sat silent for the whole idle budget, so agent-session uses
		// this class to escalate repeated stalls to the fallback chain.
		expect(
			isProviderStreamStallError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Idle timeout waiting for provider stream after 300000ms",
				}),
			),
		).toBe(true);
		expect(
			isProviderStreamStallError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Provider stream start timed out after 90000ms",
				}),
			),
		).toBe(true);
		expect(
			isProviderStreamStallError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "Request timed out." }),
			),
		).toBe(false);
		expect(
			isProviderStreamStallError(
				fauxAssistantMessage("", {
					stopReason: "aborted",
					errorMessage: "Idle timeout waiting for provider stream after 300000ms",
				}),
			),
		).toBe(false);
	});

	it("classifies agent-loop stream idle timeouts as retryable", () => {
		// Emitted by @earendil-works/pi-agent-core when a provider stream stops
		// delivering events (e.g. a connection that died after a network change).
		// Must stay retryable so sessions recover instead of surfacing a dead end.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Idle timeout waiting for provider stream after 300000ms",
				}),
			),
		).toBe(true);
	});

	it("matches upstream request buffer exhaustion wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "Error: exceeded request buffer limit while retrying upstream",
				}),
			),
		).toBe(true);
	});

	it.each([
		wrappedDnsLookupError,
		"connect ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"getaddrinfo failed for api.example.com",
	])("matches DNS transport failure wording: %s", (errorMessage) => {
		expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(true);
	});
	it("matches OpenAI Responses streams that end before terminal events", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIResponsesEarlyEofMessage }),
			),
		).toBe(true);
	});

	it("classifies Anthropic server-tool pairing 400s as retryable", () => {
		// A turn that persisted a `server_tool_use` without its result makes every
		// later request 400. The replayed history is repaired before the retried
		// request is built, so the retry (and, if it keeps failing, the model
		// fallback chain) is what unwedges the session instead of dead-ending it.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: anthropicOrphanServerToolMessage }),
			),
		).toBe(true);
	});

	it("keeps unrelated invalid_request errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: anthropicInvalidMaxTokensMessage }),
			),
		).toBe(false);
	});

	it("keeps gateway-wrapped tool-schema rejections non-retryable", () => {
		// Apitopia wraps Kimi's deterministic request-shape rejection in a 500
		// server_error envelope. The status text says transient, the semantics say
		// permanent: the identical payload is rejected on every attempt and on every
		// fallback model, so retrying only burns the turn (observed 2026-08-04).
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: apitopiaToolSchemaRejectionMessage }),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: moonshotToolSchemaRejectionMessage }),
			),
		).toBe(false);
	});

	it("keeps genuine transient server errors retryable alongside schema rejections", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: openAIServerErrorMessage }),
			),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "500 server_error: internal error, please retry",
				}),
			),
		).toBe(true);
	});

	it("matches the canonical gateway model-request rejection as transient", () => {
		// Gateways/proxies answer with "The model request was rejected. Check the
		// request and try again." when the upstream lane is momentarily unable to
		// serve the request. Coupling both sentences keeps unrelated permission,
		// request-shape, and content-policy rejections terminal.
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: gatewayModelRequestRejectedMessage }),
			),
		).toBe(true);
	});

	it.each(nonCanonicalModelRequestRejectionMessages)(
		"keeps non-canonical model-request rejections terminal: %s",
		(errorMessage) => {
			expect(isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage }))).toBe(false);
		},
	);

	it.each(["refusal", "sensitive"] as const)(
		"keeps typed %s messages terminal even with the canonical retry wording",
		(type) => {
			expect(
				isRetryableAssistantError(
					fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: gatewayModelRequestRejectedMessage,
						stopDetails: { type },
					}),
				),
			).toBe(false);
		},
	);

	it("keeps non-retryable overlap precedence over the canonical retry wording", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `${gatewayModelRequestRejectedMessage} quota exceeded`,
				}),
			),
		).toBe(false);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: `${gatewayModelRequestRejectedMessage} Invalid request: tools.0.function.parameters.type is required`,
				}),
			),
		).toBe(false);
	});

	it("keeps provider limit errors non-retryable", () => {
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "429 quota exceeded" }),
			),
		).toBe(false);
	});

	it("keeps anthropic credits_required errors non-retryable", () => {
		// Verbatim 429 from a real session (2026-07-29, anthropic claude-fable-5):
		// a billing-dead account must not burn same-model retries before the
		// fallback chain takes over.
		const creditsRequired =
			'429 event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"Usage credits are required for this model.","details":{"error_code":"credits_required","model":"claude-fable-5"}},"request_id":"req_011CdW2nFxprAx6KQ9JhnAvq"}';
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: creditsRequired })),
		).toBe(false);
	});

	it("classifies assistant error messages", () => {
		expect(
			isRetryableAssistantError(fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" })),
		).toBe(true);
		expect(
			isRetryableAssistantError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "524 status code (no body)" }),
			),
		).toBe(true);
		expect(isRetryableAssistantError(fauxAssistantMessage("not an error"))).toBe(false);
	});
});

describe("retryAssistantCall", () => {
	const disabled: RetryPolicy = { enabled: false, maxRetries: 3, baseDelayMs: 0 };
	const enabled: RetryPolicy = { enabled: true, maxRetries: 3, baseDelayMs: 0 };

	it("returns a successful response immediately without retrying", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("ok"));
		const res = await retryAssistantCall(produce, enabled, undefined);
		expect(res.content).toEqual([{ type: "text", text: "ok" }]);
		expect(produce).toHaveBeenCalledTimes(1);
	});

	it("does not retry an aborted message", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "aborted" }));
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
	});

	it("does not retry a non-retryable error (quota/billing)", async () => {
		const produce = vi.fn(async () =>
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
		);
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("retries a transient error up to maxRetries then returns the final error", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
		expect(onRetryScheduled).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 3, "terminated");
	});

	it("stops retrying once a call succeeds", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(3);
		expect(onRetryFinished).toHaveBeenCalledWith(true, 2);
	});

	it("retries a model-request rejection once then returns the recovered response", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n < 2
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: gatewayModelRequestRejectedMessage })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryScheduled).toHaveBeenCalledTimes(1);
	});

	it("reports an aborted retried call as unsuccessful", async () => {
		let n = 0;
		const produce = vi.fn(async () => {
			n++;
			return n === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("", { stopReason: "aborted" });
		});
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryFinished });
		expect(res.stopReason).toBe("aborted");
		expect(produce).toHaveBeenCalledTimes(2);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1);
	});

	it("does not retry when policy is disabled", async () => {
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const onRetryScheduled = vi.fn();
		const onRetryFinished = vi.fn();
		const res = await retryAssistantCall(produce, disabled, undefined, { onRetryScheduled, onRetryFinished });
		expect(res.stopReason).toBe("error");
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryScheduled).not.toHaveBeenCalled();
		expect(onRetryFinished).not.toHaveBeenCalled();
	});

	it("emits onRetryAttemptStart after backoff before each retried call", async () => {
		const events: string[] = [];
		let n = 0;
		const produce = vi.fn(async () => {
			events.push(`produce:${n}`);
			n++;
			return n < 3
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" })
				: fauxAssistantMessage("recovered");
		});
		const onRetryScheduled = vi.fn((attempt: number) => {
			events.push(`retry:${attempt}`);
		});
		const onRetryAttemptStart = vi.fn(() => {
			events.push("attempt-start");
		});
		const res = await retryAssistantCall(produce, enabled, undefined, { onRetryScheduled, onRetryAttemptStart });
		expect(res.content).toEqual([{ type: "text", text: "recovered" }]);
		expect(onRetryScheduled).toHaveBeenCalledTimes(2);
		expect(onRetryAttemptStart).toHaveBeenCalledTimes(2);
		expect(events).toEqual([
			"produce:0",
			"retry:1",
			"attempt-start",
			"produce:1",
			"retry:2",
			"attempt-start",
			"produce:2",
		]);
	});

	it("aborts backoff sleep via signal, returns an aborted message, and emits onRetryFinished(false)", async () => {
		const controller = new AbortController();
		const produce = vi.fn(async () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "terminated" }));
		const policy: RetryPolicy = { enabled: true, maxRetries: 5, baseDelayMs: 10_000 };
		const onRetryFinished = vi.fn();
		const p = retryAssistantCall(produce, policy, controller.signal, { onRetryFinished });
		// Let one error call resolve and the first backoff sleep start, then abort.
		await vi.waitFor(() => expect(produce).toHaveBeenCalled());
		controller.abort();
		const res = await p;
		expect(res.stopReason).toBe("aborted");
		expect(res.errorMessage).toBeUndefined();
		expect(produce).toHaveBeenCalledTimes(1);
		expect(onRetryFinished).toHaveBeenCalledWith(false, 1, "terminated");
	});
});
