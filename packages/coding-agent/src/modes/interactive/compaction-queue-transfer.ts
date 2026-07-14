export type CompactionQueuedMessage = {
	readonly text: string;
	readonly mode: "steer" | "followUp";
};

export type PromptDisposition = "handled" | "queued" | "started";

type TransferOptions = {
	readonly willRetry?: boolean;
};

type TransferDependencies = {
	readonly takeBatch: () => CompactionQueuedMessage[];
	readonly commitAccepted: (message: CompactionQueuedMessage) => boolean;
	readonly restoreUndelivered: (messages: readonly CompactionQueuedMessage[]) => number;
	readonly isCommand: (message: CompactionQueuedMessage) => boolean;
	readonly deliverCommand: (message: CompactionQueuedMessage) => Promise<void>;
	readonly deliverFirstPrompt: (message: CompactionQueuedMessage) => Promise<PromptDisposition>;
	readonly deliverQueued: (message: CompactionQueuedMessage) => Promise<void>;
	readonly reportFailure: (error: unknown, undeliveredCount: number) => void;
};

export async function transferCompactionQueue(
	dependencies: TransferDependencies,
	options: TransferOptions = {},
): Promise<void> {
	const batch = dependencies.takeBatch();
	if (batch.length === 0) return;

	let acceptedCount = 0;
	try {
		if (options.willRetry) {
			for (const message of batch) {
				if (dependencies.isCommand(message)) {
					await dependencies.deliverCommand(message);
				} else {
					await dependencies.deliverQueued(message);
				}
				if (!dependencies.commitAccepted(message)) return;
				acceptedCount += 1;
			}
			return;
		}

		let promptWorkOwned = false;
		for (const message of batch) {
			if (dependencies.isCommand(message)) {
				await dependencies.deliverCommand(message);
			} else if (!promptWorkOwned) {
				const disposition = await dependencies.deliverFirstPrompt(message);
				promptWorkOwned = disposition !== "handled";
			} else {
				await dependencies.deliverQueued(message);
			}
			if (!dependencies.commitAccepted(message)) return;
			acceptedCount += 1;
		}
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		const undelivered = batch.slice(acceptedCount);
		const restoredCount = dependencies.restoreUndelivered(undelivered);
		if (restoredCount > 0) {
			dependencies.reportFailure(failure, restoredCount);
		}
	}
}

export function waitForPromptDisposition(
	startPrompt: (
		preflightResult: (success: boolean) => void,
		promptDisposition: (disposition: PromptDisposition) => void,
	) => Promise<void>,
	reportPostAcceptanceFailure: (error: unknown) => void,
): Promise<PromptDisposition> {
	return new Promise<PromptDisposition>((resolve, reject) => {
		let accepted = false;
		let rejectedAtPreflight = false;
		let disposition: PromptDisposition | undefined;
		const resolveAcceptedDisposition = (): void => {
			if (accepted && disposition) resolve(disposition);
		};
		const prompt = startPrompt(
			(success) => {
				if (success) {
					accepted = true;
					resolveAcceptedDisposition();
				} else {
					rejectedAtPreflight = true;
				}
			},
			(nextDisposition) => {
				disposition = nextDisposition;
				resolveAcceptedDisposition();
			},
		);

		void prompt.then(
			() => {
				if (rejectedAtPreflight && !accepted) {
					reject(new Error("Queued prompt was rejected before acceptance"));
				}
			},
			(error: unknown) => {
				if (accepted) {
					reportPostAcceptanceFailure(error);
				} else {
					reject(error);
				}
			},
		);
	});
}
