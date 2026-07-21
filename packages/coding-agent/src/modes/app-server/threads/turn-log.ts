export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export type WireItem = Record<string, unknown>;

export interface LoggedTurn {
	turnId: string;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	error: string | null;
	status: TurnStatus;
	items: WireItem[];
}

export interface RecordTurnOptions {
	turnId: string;
	startedAt: string;
	status?: TurnStatus;
	completedAt?: string | null;
	error?: string | null;
}

export interface CompleteTurnOptions {
	readonly status: Exclude<TurnStatus, "running">;
	readonly completedAt: string;
	readonly error?: string | null;
}

export class TurnLog {
	private readonly turnsByThreadId = new Map<string, LoggedTurn[]>();

	recordTurn(threadId: string, turn: RecordTurnOptions): LoggedTurn {
		const turns = this.getThreadTurns(threadId);
		const loggedTurn: LoggedTurn = {
			turnId: turn.turnId,
			startedAt: turn.startedAt,
			completedAt: turn.completedAt ?? null,
			durationMs: durationBetween(turn.startedAt, turn.completedAt ?? null),
			error: turn.error ?? null,
			status: turn.status ?? "running",
			items: [],
		};
		turns.push(loggedTurn);
		return cloneTurn(loggedTurn);
	}

	appendItem(threadId: string, turnId: string, item: WireItem): void {
		const turn = this.getThreadTurns(threadId).find((candidate) => candidate.turnId === turnId);
		if (!turn) {
			throw new Error(`Turn not found: ${turnId}`);
		}
		turn.items.push(cloneWireItem(item));
	}

	completeTurn(threadId: string, turnId: string, completion: CompleteTurnOptions): void {
		const turn = this.getThreadTurns(threadId).find((candidate) => candidate.turnId === turnId);
		if (!turn) {
			throw new Error(`Turn not found: ${turnId}`);
		}
		turn.status = completion.status;
		turn.completedAt = completion.completedAt;
		turn.durationMs = durationBetween(turn.startedAt, completion.completedAt);
		turn.error = completion.error ?? null;
	}

	readTurns(threadId: string): LoggedTurn[] {
		return this.getThreadTurns(threadId).map(cloneTurn);
	}

	private getThreadTurns(threadId: string): LoggedTurn[] {
		let turns = this.turnsByThreadId.get(threadId);
		if (!turns) {
			turns = [];
			this.turnsByThreadId.set(threadId, turns);
		}
		return turns;
	}
}

function cloneTurn(turn: LoggedTurn): LoggedTurn {
	return {
		turnId: turn.turnId,
		startedAt: turn.startedAt,
		completedAt: turn.completedAt,
		durationMs: turn.durationMs,
		error: turn.error,
		status: turn.status,
		items: turn.items.map(cloneWireItem),
	};
}

function cloneWireItem(item: WireItem): WireItem {
	return { ...item };
}

function durationBetween(startedAt: string, completedAt: string | null): number | null {
	if (completedAt === null) return null;
	const startedAtMs = Date.parse(startedAt);
	const completedAtMs = Date.parse(completedAt);
	return Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs) ? completedAtMs - startedAtMs : null;
}
