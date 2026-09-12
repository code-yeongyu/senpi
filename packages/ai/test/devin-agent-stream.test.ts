import { fromBinary } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	AssignModelRequestSchema,
	GetUserJwtRequestSchema,
	StopReason,
} from "../src/api/devin-agent/gen/cascade_pb.ts";
import { stream as devinStream } from "../src/api/devin-agent.ts";
import type { Model } from "../src/types.ts";
import {
	ASSIGN_MODEL_PATH,
	CHAT_PATH,
	CONTEXT,
	closeStubServers,
	collect,
	decodeChatFrame,
	deltas,
	frame,
	MODEL,
	serveEdge,
	trailer,
	USER_JWT_PATH,
	UUID_SHAPE,
} from "./devin-agent-stream-harness.ts";

afterEach(closeStubServers);

describe.sequential("devin-agent stream: auth, host and router", () => {
	it("mints a user JWT first, then streams the chat with the released CLI headers", async () => {
		const { baseUrl, seen } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "m1", deltaThinking: "weighing" }));
				res.write(frame({ messageId: "m1", deltaText: "Hel" }));
				res.write(frame({ messageId: "m1", deltaText: "lo" }, true));
				res.write(
					frame({
						messageId: "m1",
						deltaToolCalls: [{ id: "call-1", name: "read", argumentsJson: '{"path":"a.ts"}' }],
						stopReason: StopReason.FUNCTION_CALL,
						usage: { inputTokens: 11n, outputTokens: 7n, cacheReadTokens: 3n, cacheWriteTokens: 2n },
					}),
				);
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...MODEL, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);

		expect(events[0]?.type).toBe("start");
		expect(deltas(events, "thinking_delta")).toEqual(["weighing"]);
		expect(deltas(events, "text_delta")).toEqual(["Hel", "lo"]);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.reason).toBe("toolUse");
		expect(done.message.content.find((c) => c.type === "toolCall")).toMatchObject({
			id: "call-1",
			name: "read",
			arguments: { path: "a.ts" },
		});
		expect(done.message.usage).toMatchObject({ input: 11, output: 7, cacheRead: 3, cacheWrite: 2 });
		expect(done.message.responseId).toBe("m1");

		expect(seen.map((r) => r.path)).toEqual([USER_JWT_PATH, CHAT_PATH]);
		const auth = seen[0];
		const chat = seen[1];
		if (!auth || !chat) throw new Error("expected two requests");
		expect(auth.headers["content-type"]).toBe("application/proto");
		expect(auth.headers["connect-protocol-version"]).toBe("1");
		expect(auth.headers.authorization).toBeUndefined();
		const authRequest = fromBinary(GetUserJwtRequestSchema, auth.body);
		expect(authRequest.metadata).toMatchObject({
			apiKey: "devin-session-token$session-abc",
			ideName: "devin-cli",
			ideType: "chisel",
			userJwt: "",
		});

		expect(chat.headers["content-type"]).toBe("application/connect+proto");
		expect(chat.headers["connect-protocol-version"]).toBe("1");
		expect(chat.headers["connect-content-encoding"]).toBe("gzip");
		expect(chat.headers["connect-accept-encoding"]).toBe("gzip");
		expect(chat.headers["accept-encoding"]).toBe("identity");
		expect(chat.headers["user-agent"]).toBe("connect-go/1.18.1 (go1.26.3)");
		expect(chat.headers.authorization).toBeUndefined();
		const chatRequest = decodeChatFrame(chat.body);
		expect(chatRequest.metadata?.userJwt).toBe("jwt-1");
		expect(chatRequest.metadata?.apiKey).toBe("devin-session-token$session-abc");
		expect(chatRequest.cascadeId).toMatch(UUID_SHAPE);
		expect(chatRequest.executionId).toMatch(UUID_SHAPE);
		expect(chatRequest.chatModelUid).toBe("swe-1-6");
	});

	it("follows the account host GetUserJwt hands back instead of the seeded base", async () => {
		const tenant = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "t1", deltaText: "tenant" }));
				res.write(trailer());
				res.end();
			},
		});
		const seeded = await serveEdge({
			customApiServerUrl: `${tenant.baseUrl}/`,
			chat: (_req, res) => {
				res.writeHead(500);
				res.end("wrong host");
			},
		});

		const events = await collect(
			devinStream({ ...MODEL, baseUrl: seeded.baseUrl }, CONTEXT, { apiKey: "session-abc" } as never),
		);
		expect(events.at(-1)?.type).toBe("done");
		expect(deltas(events, "text_delta")).toEqual(["tenant"]);
		expect(seeded.seen.map((r) => r.path)).toEqual([USER_JWT_PATH]);
		expect(tenant.seen.map((r) => r.path)).toEqual([CHAT_PATH]);
	});

	it("fails the turn before any chat request when GetUserJwt is rejected or empty", async () => {
		const rejected = await serveEdge({
			userJwtStatus: 401,
			chat: (_req, res) => {
				res.writeHead(200);
				res.end();
			},
		});
		const failed = await collect(
			devinStream({ ...MODEL, baseUrl: rejected.baseUrl }, CONTEXT, { apiKey: "session-abc" } as never),
		);
		const last = failed.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.error.errorMessage).toMatch(/401/);
		expect(rejected.seen.map((r) => r.path)).toEqual([USER_JWT_PATH]);

		const empty = await serveEdge({
			userJwt: "",
			chat: (_req, res) => {
				res.writeHead(200);
				res.end();
			},
		});
		const emptyEvents = await collect(
			devinStream({ ...MODEL, baseUrl: empty.baseUrl }, CONTEXT, { apiKey: "session-abc" } as never),
		);
		const emptyLast = emptyEvents.at(-1);
		expect(emptyLast?.type).toBe("error");
		if (emptyLast?.type !== "error") throw new Error("expected error");
		expect(emptyLast.error.errorMessage).toMatch(/user JWT/i);
		expect(empty.seen.map((r) => r.path)).toEqual([USER_JWT_PATH]);
	});

	it("resolves a router model through AssignModel and chats on the assigned uid", async () => {
		const router = { ...MODEL, id: "adaptive", compat: { modelRouter: true } } as unknown as Model<"devin-agent">;
		const { baseUrl, seen } = await serveEdge({
			assignment: { modelUid: "claude-sonnet-5-medium", assignmentJwt: "assign-jwt" },
			chat: (_req, res) => {
				res.writeHead(200, { "content-type": "application/connect+proto" });
				res.write(frame({ messageId: "r1", deltaText: "routed", actualModelUid: "claude-sonnet-5-medium" }));
				res.write(trailer());
				res.end();
			},
		});

		const events = await collect(devinStream({ ...router, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const done = events.at(-1);
		expect(done?.type).toBe("done");
		if (done?.type !== "done") throw new Error("expected done");
		expect(done.message.responseModel).toBe("claude-sonnet-5-medium");

		expect(seen.map((r) => r.path)).toEqual([USER_JWT_PATH, ASSIGN_MODEL_PATH, CHAT_PATH]);
		const assign = seen[1];
		const chat = seen[2];
		if (!assign || !chat) throw new Error("expected assign + chat");
		expect(assign.headers["content-type"]).toBe("application/proto");
		const assignRequest = fromBinary(AssignModelRequestSchema, assign.body);
		expect(assignRequest.modelRouterUid).toBe("adaptive");
		expect(assignRequest.chatMessagePrompt?.prompt).toBe("hi");
		expect(assignRequest.metadata?.userJwt).toBe("");
		const chatRequest = decodeChatFrame(chat.body);
		expect(chatRequest.cascadeId).toBe(assignRequest.cascadeId);
		expect(chatRequest.chatModelUid).toBe("claude-sonnet-5-medium");
		expect(chatRequest.modelAssignmentJwt).toBe("assign-jwt");
	});

	it("fails a router turn when AssignModel returns no assignment instead of sending the router uid", async () => {
		const router = { ...MODEL, id: "adaptive", compat: { modelRouter: true } } as unknown as Model<"devin-agent">;
		const { baseUrl, seen } = await serveEdge({
			chat: (_req, res) => {
				res.writeHead(200);
				res.end();
			},
		});
		const events = await collect(devinStream({ ...router, baseUrl }, CONTEXT, { apiKey: "session-abc" } as never));
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type !== "error") throw new Error("expected error");
		expect(last.error.errorMessage).toMatch(/AssignModel/);
		expect(seen.map((r) => r.path)).toEqual([USER_JWT_PATH, ASSIGN_MODEL_PATH]);
	});
});
