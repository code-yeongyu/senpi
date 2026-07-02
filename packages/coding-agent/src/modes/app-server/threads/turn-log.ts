export type TurnStatus = "running" | "completed" | "failed" | "interrupted";

export type WireItem = Record<string, unknown>;

export interface LoggedTurn {
	turnId: string;
	startedAt: string;
	status: TurnStatus;
	items: WireItem[];
}

export interface RecordTurnOptions {
	turnId: string;
	startedAt: string;
	status?: TurnStatus;
}

export class TurnLog {
	private readonly turnsByThreadId = new Map<string, LoggedTurn[]>();

	recordTurn(threadId: string, turn: RecordTurnOptions): LoggedTurn {
		const turns = this.getThreadTurns(threadId);
		const loggedTurn: LoggedTurn = {
			turnId: turn.turnId,
			startedAt: turn.startedAt,
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
		status: turn.status,
		items: turn.items.map(cloneWireItem),
	};
}

function cloneWireItem(item: WireItem): WireItem {
	return { ...item };
}
