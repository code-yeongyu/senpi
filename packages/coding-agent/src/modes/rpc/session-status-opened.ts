/** The `session_opened` record: the first lifecycle record of every session a host creates. */
import type { SessionKind } from "../../core/extensions/types.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { PublishedSessionContext } from "./session-status.ts";

export interface SessionOpenedRecord {
	readonly type: "session_opened";
	readonly sessionId: string;
	readonly durableSessionId?: string;
	readonly sessionPath?: string;
	readonly kind: SessionKind;
	readonly cwd: string;
	readonly context?: PublishedSessionContext;
}

/** The two wire forms: `plain` for every recipient, `withContext` for subscribers that asked for context. */
export function sessionOpenedLines(record: SessionOpenedRecord): {
	readonly plain: string;
	readonly withContext: string;
} {
	const { context, ...plain } = record;
	return {
		plain: serializeJsonLine(plain),
		withContext: serializeJsonLine(context === undefined ? plain : { ...plain, context }),
	};
}
