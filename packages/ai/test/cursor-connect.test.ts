import { describe, expect, it, vi } from "vitest";
import { cursorConnectApi } from "../src/api/cursor-connect.lazy.ts";
import { cursorProvider } from "../src/providers/cursor.ts";
import type { Model } from "../src/types.ts";

describe("Cursor Connect transport", () => {
	it("advertises cursor-connect api instead of openai-completions", () => {
		const provider = cursorProvider();
		expect(provider.getModels()[0]?.api).toBe("cursor-connect");
	});

	it("posts Connect protobuf AgentRun frames to Cursor ChatService", async () => {
		const fetches: Array<{ url: string; headers: Headers; body: Uint8Array }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				const body =
					init?.body instanceof Uint8Array
						? init.body
						: init?.body instanceof ArrayBuffer
							? new Uint8Array(init.body)
							: new Uint8Array(Buffer.from(String(init?.body ?? ""), "binary"));
				fetches.push({ url, headers, body });
				// Minimal Connect end-stream JSON trailer (gzip flag 0, length of payload).
				const trailer = Buffer.from(JSON.stringify({}));
				const frame = Buffer.alloc(5 + trailer.length);
				frame[0] = 0x02; // end-stream JSON
				frame.writeUInt32BE(trailer.length, 1);
				trailer.copy(frame, 5);
				return new Response(frame, {
					status: 200,
					headers: { "content-type": "application/connect+proto" },
				});
			}),
		);

		const model = {
			id: "default",
			name: "Auto",
			api: "cursor-connect",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		} satisfies Model<"cursor-connect">;

		const message = await cursorConnectApi()
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "cursor-token" },
			)
			.result();

		expect(fetches).toHaveLength(1);
		expect(fetches[0]?.url).toContain("aiserver.v1.ChatService/StreamUnifiedChatWithTools");
		expect(fetches[0]?.headers.get("content-type")).toBe("application/connect+proto");
		expect(fetches[0]?.headers.get("connect-protocol-version")).toBe("1");
		expect(fetches[0]?.headers.get("authorization")).toBe("Bearer cursor-token");
		expect(fetches[0]?.body[0]).toBe(0x00); // uncompressed connect envelope
		expect(message.stopReason === "stop" || message.stopReason === "error").toBe(true);
		vi.unstubAllGlobals();
	});
});
