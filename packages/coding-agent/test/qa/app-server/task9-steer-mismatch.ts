import { TurnLog } from "../../../src/modes/app-server/threads/turn-log.ts";
import {
	createTurnEngine,
	TurnEngineError,
	type TurnEngineSession,
	type TurnEngineStore,
} from "../../../src/modes/app-server/threads/turns.ts";

class QaSession implements TurnEngineSession {
	steerCalls = 0;
	private readonly listeners: Array<(event: { readonly type: "agent_end" }) => void> = [];

	async prompt(): Promise<void> {}

	async steer(): Promise<void> {
		this.steerCalls += 1;
	}

	async abort(): Promise<void> {
		this.emitAgentEnd();
	}

	subscribe(listener: (event: { readonly type: "agent_end" }) => void): () => void {
		this.listeners.push(listener);
		return () => {};
	}

	emitAgentEnd(): void {
		for (const listener of [...this.listeners]) {
			listener({ type: "agent_end" });
		}
	}
}

type QaEntry = {
	readonly id: string;
	readonly session: QaSession;
	activeTurn: { readonly turnId: string; readonly startedAt: string } | null;
	status: "idle" | "active";
	updatedAt: string;
	taskQueue: Promise<void>;
};

class QaStore implements TurnEngineStore<QaEntry> {
	readonly entry: QaEntry = {
		id: "thread-qa",
		session: new QaSession(),
		activeTurn: null,
		status: "idle",
		updatedAt: "2026-07-02T00:00:00.000Z",
		taskQueue: Promise.resolve(),
	};

	getLoadedThread(threadId: string): QaEntry {
		if (threadId !== this.entry.id) {
			throw new Error(`missing thread ${threadId}`);
		}
		return this.entry;
	}

	runThreadTask<T>(_threadId: string, task: () => Promise<T> | T): Promise<T> {
		const run = this.entry.taskQueue.then(task, task);
		this.entry.taskQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

async function main(): Promise<void> {
	const store = new QaStore();
	const engine = createTurnEngine({
		store,
		turnLog: new TurnLog(),
		emitToThread: () => {},
		broadcast: () => {},
	});
	const started = await engine.startTurn({ threadId: "thread-qa", input: [{ type: "text", text: "hello" }] });
	try {
		await engine.steerTurn({
			threadId: "thread-qa",
			expectedTurnId: "stale-id",
			input: [{ type: "text", text: "steer" }],
		});
		throw new Error("stale steer unexpectedly succeeded");
	} catch (error) {
		if (!(error instanceof TurnEngineError)) {
			throw error;
		}
		console.log(`ERROR_MESSAGE=${error.error.message}`);
		console.log(`ACTUAL_TURN_ID=${started.turn.id}`);
		console.log(`STEER_CALLS=${store.entry.session.steerCalls}`);
		if (!error.error.message.includes("stale-id") || !error.error.message.includes(started.turn.id)) {
			throw new Error("mismatch error did not contain stale and actual turn ids");
		}
		if (store.entry.session.steerCalls !== 0) {
			throw new Error("stale steer reached the session");
		}
	} finally {
		store.entry.session.emitAgentEnd();
		await store.entry.taskQueue;
	}
}

main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
