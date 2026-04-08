import { describe, expect, it, vi } from "vitest";
import {
	createEventEmitter,
	createLocalEventEmitter,
	type PermissionAskedEvent,
	type PermissionRepliedEvent,
} from "../../src/core/extensions/builtin/permission-system/events.js";
import type { Reply, Request } from "../../src/core/extensions/builtin/permission-system/types.js";
import type { ExtensionAPI } from "../../src/core/extensions/types.js";

describe("createEventEmitter", () => {
	it("emits permission_asked event via pi.events", () => {
		// given
		const mockEmit = vi.fn();
		const mockPi = { events: { emit: mockEmit } } as unknown as ExtensionAPI;
		const emitter = createEventEmitter(mockPi);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "bash",
			patterns: ["/home/user/file.txt"],
			always: [],
			metadata: {},
		};

		// when
		emitter.emitAsked(request);

		// then
		expect(mockEmit).toHaveBeenCalledWith("permission_asked", request);
	});

	it("emits permission_replied event via pi.events", () => {
		// given
		const mockEmit = vi.fn();
		const mockPi = { events: { emit: mockEmit } } as unknown as ExtensionAPI;
		const emitter = createEventEmitter(mockPi);
		const requestID = "req-123";
		const sessionID = "sess-456";
		const reply: Reply = "once";

		// when
		emitter.emitReplied(requestID, sessionID, reply);

		// then
		expect(mockEmit).toHaveBeenCalledWith("permission_replied", {
			requestID,
			sessionID,
			reply,
		});
	});
});

describe("createLocalEventEmitter", () => {
	it("emits permission_asked to registered handlers", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler = vi.fn();
		emitter.onAsked(handler);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "bash",
			patterns: ["/home/user/file.txt"],
			always: [],
			metadata: {},
		};

		// when
		emitter.emitAsked(request);

		// then
		expect(handler).toHaveBeenCalledWith(request);
	});

	it("emits permission_replied to registered handlers", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler = vi.fn();
		emitter.onReplied(handler);
		const requestID = "req-123";
		const sessionID = "sess-456";
		const reply: Reply = "always";

		// when
		emitter.emitReplied(requestID, sessionID, reply);

		// then
		expect(handler).toHaveBeenCalledWith({ requestID, sessionID, reply });
	});

	it("supports multiple asked handlers", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		emitter.onAsked(handler1);
		emitter.onAsked(handler2);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "write",
			patterns: ["/path/to/file"],
			always: [],
			metadata: {},
		};

		// when
		emitter.emitAsked(request);

		// then
		expect(handler1).toHaveBeenCalledWith(request);
		expect(handler2).toHaveBeenCalledWith(request);
	});

	it("supports multiple replied handlers", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		emitter.onReplied(handler1);
		emitter.onReplied(handler2);

		// when
		emitter.emitReplied("req-1", "sess-1", "reject");

		// then
		expect(handler1).toHaveBeenCalledWith({
			requestID: "req-1",
			sessionID: "sess-1",
			reply: "reject",
		});
		expect(handler2).toHaveBeenCalledWith({
			requestID: "req-1",
			sessionID: "sess-1",
			reply: "reject",
		});
	});

	it("allows unsubscribing from asked events", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler = vi.fn();
		const unsubscribe = emitter.onAsked(handler);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "bash",
			patterns: ["*.txt"],
			always: [],
			metadata: {},
		};

		// when
		unsubscribe();
		emitter.emitAsked(request);

		// then
		expect(handler).not.toHaveBeenCalled();
	});

	it("allows unsubscribing from replied events", () => {
		// given
		const emitter = createLocalEventEmitter();
		const handler = vi.fn();
		const unsubscribe = emitter.onReplied(handler);

		// when
		unsubscribe();
		emitter.emitReplied("req-1", "sess-1", "once");

		// then
		expect(handler).not.toHaveBeenCalled();
	});

	it("clears all handlers when clear is called", () => {
		// given
		const emitter = createLocalEventEmitter();
		const askedHandler = vi.fn();
		const repliedHandler = vi.fn();
		emitter.onAsked(askedHandler);
		emitter.onReplied(repliedHandler);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "edit",
			patterns: ["src/**/*.ts"],
			always: [],
			metadata: {},
		};

		// when
		emitter.clear();
		emitter.emitAsked(request);
		emitter.emitReplied("req-1", "sess-1", "always");

		// then
		expect(askedHandler).not.toHaveBeenCalled();
		expect(repliedHandler).not.toHaveBeenCalled();
	});

	it("continues emitting to other handlers when one throws", () => {
		// given
		const emitter = createLocalEventEmitter();
		const errorHandler = vi.fn(() => {
			throw new Error("Handler error");
		});
		const goodHandler = vi.fn();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		emitter.onAsked(errorHandler);
		emitter.onAsked(goodHandler);
		const request: Request = {
			id: "req-123",
			sessionID: "sess-456",
			permission: "bash",
			patterns: ["/etc/passwd"],
			always: [],
			metadata: {},
		};

		// when
		emitter.emitAsked(request);

		// then
		expect(errorHandler).toHaveBeenCalledWith(request);
		expect(goodHandler).toHaveBeenCalledWith(request);
		expect(consoleSpy).toHaveBeenCalledWith("Error in permission_asked handler:", expect.any(Error));

		consoleSpy.mockRestore();
	});

	it("continues emitting replied events when one handler throws", () => {
		// given
		const emitter = createLocalEventEmitter();
		const errorHandler = vi.fn(() => {
			throw new Error("Handler error");
		});
		const goodHandler = vi.fn();
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		emitter.onReplied(errorHandler);
		emitter.onReplied(goodHandler);

		// when
		emitter.emitReplied("req-1", "sess-1", "once");

		// then
		expect(errorHandler).toHaveBeenCalledWith({ requestID: "req-1", sessionID: "sess-1", reply: "once" });
		expect(goodHandler).toHaveBeenCalledWith({ requestID: "req-1", sessionID: "sess-1", reply: "once" });
		expect(consoleSpy).toHaveBeenCalledWith("Error in permission_replied handler:", expect.any(Error));

		consoleSpy.mockRestore();
	});

	it("exports correct event type aliases", () => {
		// given
		const request: PermissionAskedEvent = {
			id: "req-1",
			sessionID: "sess-1",
			permission: "bash",
			patterns: ["/tmp/test"],
			always: [],
			metadata: {},
		};
		const replied: PermissionRepliedEvent = {
			requestID: "req-1",
			sessionID: "sess-1",
			reply: "always",
		};

		// then - types compile correctly
		expect(request.id).toBe("req-1");
		expect(replied.reply).toBe("always");
	});
});
