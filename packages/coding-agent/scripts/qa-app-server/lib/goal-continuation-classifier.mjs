export function countContinuationRequests(requests) {
	return requests.filter(
		(request) => request.url?.includes("chat/completions") && requestContainsContinuation(request),
	).length;
}

export function isContinuationMessage(message) {
	const serialized = JSON.stringify(message);
	return (
		serialized.includes("goal-continuation") ||
		serialized.includes("<goal-continuation>") ||
		(message?.role === "user" && serialized.includes("Continue working toward the active thread goal."))
	);
}

function requestContainsContinuation(request) {
	return (request.messages ?? []).some(isContinuationMessage);
}
