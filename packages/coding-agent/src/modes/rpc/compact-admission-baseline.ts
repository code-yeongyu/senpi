import { serializeJsonLine } from "./jsonl.ts";
import { GeneratedFramesCursor } from "./legacy-view-cursor.ts";
import type { EventLease } from "./compact-recovery-types.ts";

/** Identity first, then a pageable checkpoint identity, in one installed actor barrier. */
export function admissionBaseline(
	reply: Promise<Readonly<Record<string, unknown>> | undefined>,
	identity: {
		readonly sessionId: string;
		readonly admissionId: string;
		readonly generation: number;
		readonly token?: string;
		readonly eventLease?: EventLease;
		readonly componentRef?: string;
	},
	live: () => boolean,
	routes?: readonly string[],
): GeneratedFramesCursor {
	return new GeneratedFramesCursor(
		false,
		async function* () {
			const answer = await reply;
			if (answer === undefined) return;
			yield serializeJsonLine(answer);
			if (live())
				for (const admissionId of routes ?? [identity.admissionId])
					yield serializeJsonLine({
						type: "recovery_manifest",
						...identity,
						admissionId,
						componentRef: identity.componentRef ?? "manifest",
					});
		},
		() => {},
	);
}
