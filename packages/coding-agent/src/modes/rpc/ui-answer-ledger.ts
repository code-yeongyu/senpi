/** Session-generation receipts: deliberately never persisted to the transcript. */
export type UiAnswerReceipt = { readonly uiRequestId: string; readonly answerId?: string };

export class UiAnswerLedger {
	private readonly answers = new Map<string, UiAnswerReceipt>();

	lookup(uiRequestId: string, answerId: string | undefined): "replay" | "already_answered" | undefined {
		const receipt = this.answers.get(uiRequestId);
		if (!receipt) return undefined;
		return answerId !== undefined && answerId === receipt.answerId ? "replay" : "already_answered";
	}

	record(uiRequestId: string, answerId: string | undefined): void {
		if (this.answers.has(uiRequestId)) return;
		this.answers.set(uiRequestId, { uiRequestId, ...(answerId === undefined ? {} : { answerId }) });
		if (this.answers.size > 1024) {
			const oldest = this.answers.keys().next();
			if (!oldest.done) this.answers.delete(oldest.value);
		}
	}

	snapshot(): UiAnswerReceipt[] {
		return [...this.answers.values()].slice(-64).map((receipt) => ({ ...receipt }));
	}
}

const ledgers = new WeakMap<object, UiAnswerLedger>();

export function sessionUiAnswerLedger(session: object): UiAnswerLedger {
	let ledger = ledgers.get(session);
	if (!ledger) {
		ledger = new UiAnswerLedger();
		ledgers.set(session, ledger);
	}
	return ledger;
}
