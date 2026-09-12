export function isUsableCursorTaskArgs(args: unknown): args is Record<string, unknown> {
	if (!args || typeof args !== "object" || Array.isArray(args)) return false;
	const rec = args as Record<string, unknown>;
	return Boolean(
		rec.category ||
			rec.subagent_type ||
			(typeof rec.prompt === "string" && rec.prompt.trim()) ||
			(Array.isArray(rec.tasks) && rec.tasks.length > 0),
	);
}

export function keepUsableCursorTaskArgs<T>(previous: T, next: T): T {
	if (isUsableCursorTaskArgs(next)) return next;
	if (isUsableCursorTaskArgs(previous)) return previous;
	return next;
}
