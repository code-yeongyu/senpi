/** What a queued cell with nothing ahead of it is waiting on before its kernel runs it. */
export type QueuedWait = "workspace";

export function queuedWaitPhrase(language: string, waitingFor: QueuedWait | undefined): string {
	return waitingFor === "workspace"
		? `reading the workspace's files before the ${language} kernel runs it`
		: `waiting for the ${language} kernel to be ready`;
}
