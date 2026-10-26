/**
 * The durable record of runtime-identity handover operations (code-yeongyu/oh-my-openagent#10091):
 * `<daemonDir>/handovers/<operationId>.json`, mode 0600 in a 0700 directory, each phase written by rename after the
 * file is synced and the directory synced after it (`writeFileDurably`). An operation is accepted only once its
 * first record is on disk. The record names the request's terms by digest: neither the launch environment's values
 * nor any credential is ever written.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { handoverWire } from "./host-handover-wire.ts";
import type { HandoverView, IdleHandoverRequest } from "./host-idle-handover.ts";
import { writeFileDurably } from "./host-state-json.ts";

export const HANDOVER_RECORD_SCHEMA = 1;

export interface HandoverJournal {
	write(view: HandoverView, request: IdleHandoverRequest): Promise<void>;
}

export function createHandoverJournal(daemonDir: string, now: () => number = Date.now): HandoverJournal {
	const dir = join(daemonDir, "handovers");
	// One write at a time, in the order asked: a phase recorded later never lands under an earlier one.
	let tail: Promise<unknown> = Promise.resolve();
	return {
		write(view, request) {
			const written = tail.then(async () => {
				await mkdir(dir, { recursive: true, mode: 0o700 });
				const record = {
					schema: HANDOVER_RECORD_SCHEMA,
					...handoverWire(view),
					if_instance_id: request.ifInstanceId,
					if_generation: request.ifGeneration,
					terms: handoverTermsDigest(request),
					written_at: new Date(now()).toISOString(),
				};
				await writeFileDurably(join(dir, `${view.operationId}.json`), `${JSON.stringify(record, null, 2)}\n`);
			});
			tail = written.catch(() => undefined);
			return written;
		},
	};
}

/** One digest over everything a repeated request must match, environment values included, none of them stored. */
export function handoverTermsDigest(request: IdleHandoverRequest): string {
	const environment = Object.entries(request.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const terms = JSON.stringify([
		request.ifInstanceId,
		request.ifGeneration,
		request.targetRuntimeBuildId,
		request.launch.command,
		request.launch.args,
		request.hostArgs,
		environment,
		request.policy ?? null,
		request.mcpPresenterEnforcement === true,
	]);
	return `sha256:${createHash("sha256").update(terms, "utf8").digest("hex")}`;
}
