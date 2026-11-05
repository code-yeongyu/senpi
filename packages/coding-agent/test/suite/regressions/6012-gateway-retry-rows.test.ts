import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { ProviderFailure } from "../../../src/core/provider-failure.ts";
import { assistantFailure, createPresentationHarness } from "../provider-error-presentation-harness.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/6012: behind a gateway, a retryable
// failure arrives as a verbose body (a litellm 429 JSON envelope, an nginx 502 HTML page). Every
// retry attempt painted that body as its own transcript row, so one turn could carry up to
// retry.maxRetries raw rows before the reply.

const gateway429 =
	'429: {"message":"litellm.RateLimitError: {\\"error\\": {\\"type\\": \\"app_budget_state_unavailable\\", \\"message\\": \\"...Retry after 1 second.\\", \\"fields\\": {\\"cap_kind\\": \\"app_budget\\", \\"retryable\\": true, \\"retry_after_seconds\\": 1}}}","type":"throttling_error","param":null,"code":"429"} (retry-after-ms: 1000)';
const nginx502 = [
	"502 <html>",
	"<head><title>502 Bad Gateway</title></head>",
	"<body>",
	"<center><h1>502 Bad Gateway</h1></center>",
	"<hr><center>nginx</center>",
	"</body>",
	"</html>",
].join("\n");

const failure: ProviderFailure = {
	category: "unknown",
	provider: "fixture",
	model: "fixture",
	reason: "the provider returned an error",
	action: "send the message again",
};

function attempt(errorMessage: string): AssistantMessage {
	return assistantFailure(errorMessage);
}

function agentEnd(message: AssistantMessage, willRetry: boolean): AgentSessionEvent {
	return { type: "agent_end", messages: [message], willRetry, failure } as unknown as AgentSessionEvent;
}

describe("senpi#6012 gateway retry rows", () => {
	const harnesses: ReturnType<typeof createPresentationHarness>[] = [];
	function setup() {
		vi.useFakeTimers();
		const harness = createPresentationHarness();
		Object.assign(Reflect.get(harness.mode, "ui"), { setScrollbackReplayHold: vi.fn() });
		harnesses.push(harness);
		return harness;
	}
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.dispose();
		vi.useRealTimers();
	});

	const chatRows = (h: ReturnType<typeof setup>) =>
		h.chat
			.render(120)
			.map((line) => line.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, ""))
			.filter((line) => line.trim());
	const raw = /litellm|<html>|nginx|Bad Gateway|throttling_error/;

	async function failAttempt(h: ReturnType<typeof setup>, errorMessage: string, n: number, max: number) {
		const message = attempt(errorMessage);
		await h.event({ type: "message_start", message });
		await h.event({ type: "message_end", message });
		await h.event(agentEnd(message, true));
		await h.event({ type: "auto_retry_start", attempt: n, maxAttempts: max, delayMs: 5000, errorMessage });
	}

	it("three retryable gateway failures then success render one retry status and no raw rows", async () => {
		const h = setup();
		await h.event({ type: "message_start", message: { role: "user", content: "go", timestamp: 1 } });
		const userRows = chatRows(h).length;
		const bodies = [gateway429, nginx502, gateway429];
		const reasons = ["429 rate limited", "502 bad gateway", "429 rate limited"];
		for (const [index, body] of bodies.entries()) {
			await failAttempt(h, body, index + 1, 20);
			expect(chatRows(h).join("\n")).not.toMatch(raw);
			expect(chatRows(h)).toHaveLength(userRows);
			expect(h.status.children).toHaveLength(1);
			const status = h.status.render(200).join("\n");
			expect(status).toContain(`${index + 1}/20`);
			expect(status).toContain(reasons[index]);
			expect(status).toContain("5s");
		}
		const success: AssistantMessage = {
			...assistantFailure(),
			stopReason: "stop",
			errorMessage: undefined,
			content: [{ type: "text", text: "Recovered answer" }],
		};
		await h.event({ type: "message_start", message: success });
		await h.event({ type: "message_end", message: success });
		await h.event({ type: "agent_end", messages: [success], willRetry: false } as unknown as AgentSessionEvent);
		await h.event({ type: "auto_retry_end", success: true, attempt: 3 });
		await h.event({ type: "agent_idle" });
		expect(h.status.children).toHaveLength(0);
		expect(chatRows(h).join("\n")).toContain("Recovered answer");
		expect(chatRows(h).join("\n")).not.toMatch(raw);
		expect(chatRows(h).join("\n")).not.toContain("Error:");
		h.expand();
		expect(h.render(200).match(/litellm\.RateLimitError/g)).toHaveLength(1);
		expect(h.render(200)).toContain("502 Bad Gateway");
	});

	it("all retries failing renders exactly one final error row with a summarized reason", async () => {
		const h = setup();
		await h.event({ type: "message_start", message: { role: "user", content: "go", timestamp: 1 } });
		const userRows = chatRows(h).length;
		await failAttempt(h, gateway429, 1, 2);
		await failAttempt(h, nginx502, 2, 2);
		const last = attempt(nginx502);
		await h.event({ type: "message_start", message: last });
		await h.event({ type: "message_end", message: last });
		await h.event(agentEnd(last, false));
		await h.event({ type: "auto_retry_end", success: false, attempt: 2, finalError: nginx502 });
		await h.event({ type: "agent_idle" });
		const rows = chatRows(h).slice(userRows);
		expect(h.status.children).toHaveLength(0);
		expect(rows.join("\n")).not.toMatch(raw);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toContain("could not complete the request after 2 retries");
		expect(rows[0]).toContain("502 bad gateway");
		h.expand();
		expect(h.render(200)).toContain("litellm.RateLimitError");
		expect(h.render(200)).toContain("<center><h1>502 Bad Gateway</h1></center>");
	});

	it("a resumed session replays the failed attempts without raw rows", () => {
		const h = setup();
		const replay = Reflect.get(h.mode, "renderSessionItems");
		replay.call(h.mode, [
			{ role: "user", content: "go", timestamp: 1 },
			attempt(gateway429),
			attempt(nginx502),
			{
				...assistantFailure(),
				stopReason: "stop",
				errorMessage: undefined,
				content: [{ type: "text", text: "Done" }],
			},
		]);
		expect(chatRows(h).join("\n")).toContain("Done");
		expect(chatRows(h).join("\n")).not.toMatch(raw);
	});

	it("a non-retryable failure still renders its own error row", async () => {
		const h = setup();
		const denied = attempt("401 Incorrect API key provided");
		await h.event({ type: "message_start", message: denied });
		await h.event({ type: "message_end", message: denied });
		expect(chatRows(h).join("\n")).toContain("Incorrect API key provided");
	});
});
