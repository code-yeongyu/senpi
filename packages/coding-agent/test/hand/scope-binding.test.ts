// S27a (ENG-SCOPE.g): a hand keeps each execution scope's state apart and bound to the root it was opened with. A call
// that names a known scope with another root is refused, as is an execution ID the hand already accepted: nothing runs
// twice and no scope sees another's state.
import {
	type AgentToolResult,
	decodeRemoteMessage,
	HAND_CONTROL_LANE,
	encodeRemoteMessage,
	type HandScope,
	type RemoteHandMessage,
	type RemoteInvoke,
} from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupHands, openLink, startHandOn } from "./remote-hand-fixture.ts";

afterEach(cleanupHands);

interface Opened {
	readonly root: string;
	readonly ran: string[];
}

function countingScopes(opened: Map<string, Opened>) {
	return async (scope: { readonly id: string; readonly root: string }): Promise<HandScope> => {
		const state: Opened = { root: scope.root, ran: [] };
		opened.set(scope.id, state);
		return {
			run: async (call): Promise<AgentToolResult<unknown>> => {
				state.ran.push(call.toolCallId);
				return { content: [{ type: "text", text: `${scope.root}:${state.ran.length}` }], details: {} };
			},
			isSequential: () => false,
			dispose: async () => {},
		};
	};
}

function invoke(executionId: string, scope: { id: string; root: string }, toolCallId: string): RemoteInvoke {
	return { kind: "invoke", executionId, batchId: "b", index: 0, scope, toolCallId, name: "count", arguments: {} };
}

function rawSession(link: ReturnType<typeof openLink>) {
	const replies: RemoteHandMessage[] = [];
	const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
	link.brain.onFrame((frame) => {
		if (frame.lane === HAND_CONTROL_LANE) return;
		replies.push(decodeRemoteMessage(frame.payload));
		for (const waiter of waiters.splice(0)) {
			if (replies.length >= waiter.count) waiter.resolve();
			else waiters.push(waiter);
		}
	});
	return {
		replies,
		send: (message: RemoteInvoke) => link.brain.send(message.scope.id, encodeRemoteMessage(message)),
		received: (count: number) =>
			new Promise<void>((resolve) => {
				if (replies.length >= count) resolve();
				else waiters.push({ count, resolve });
			}),
	};
}

describe("execution scope binding on a hand (S27a, ENG-SCOPE.g)", () => {
	it("keeps two sessions' scopes apart, each on its own root and its own state", async () => {
		const link = openLink();
		const opened = new Map<string, Opened>();
		startHandOn(link, countingScopes(opened));
		const session = rawSession(link);
		const one = { id: "scope-one", root: "/work/one" };
		const two = { id: "scope-two", root: "/work/two" };

		await session.send(invoke("e1", one, "c1"));
		await session.send(invoke("e2", two, "c2"));
		await session.send(invoke("e3", one, "c3"));
		await session.received(3);

		expect(opened.get("scope-one")).toEqual({ root: "/work/one", ran: ["c1", "c3"] });
		expect(opened.get("scope-two")).toEqual({ root: "/work/two", ran: ["c2"] });
	});

	it("refuses a call that names a known scope with another root, running nothing", async () => {
		const link = openLink();
		const opened = new Map<string, Opened>();
		startHandOn(link, countingScopes(opened));
		const session = rawSession(link);

		await session.send(invoke("e1", { id: "scope", root: "/work/one" }, "c1"));
		await session.received(1);
		await session.send(invoke("e2", { id: "scope", root: "/elsewhere" }, "c2"));
		await session.received(2);

		expect(session.replies[1]).toEqual({ kind: "refused", executionId: "e2", reason: "scope_binding_mismatch" });
		expect(opened.get("scope")?.ran).toEqual(["c1"]);
	});

	it("runs an execution ID at most once, refusing a repeat", async () => {
		const link = openLink();
		const opened = new Map<string, Opened>();
		const executor = startHandOn(link, countingScopes(opened));
		const session = rawSession(link);
		const scope = { id: "scope", root: "/work/one" };

		await session.send(invoke("e1", scope, "c1"));
		await session.received(1);
		await session.send(invoke("e1", scope, "c1"));
		await session.received(2);

		expect(session.replies[1]).toEqual({ kind: "refused", executionId: "e1", reason: "duplicate_execution" });
		expect(opened.get("scope")?.ran).toEqual(["c1"]);
		expect(executor.accepted()).toEqual(["e1"]);
	});
});
