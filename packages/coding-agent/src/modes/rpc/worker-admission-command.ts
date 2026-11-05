import { withAdmissionReply } from "./compact-admission-reply.ts";
import type { HostToSessionWorker } from "./session-worker-protocol.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { IssuedWorkerOwners } from "./session-worker-owners.ts";
export function workerAdmissionCommand(
	message: Extract<HostToSessionWorker, { type: "command" }>,
	writer: SessionEventWriter,
	owners: IssuedWorkerOwners,
	run: () => Promise<void>,
): Promise<void> {
	return withAdmissionReply(message.admissionReply, () => {
		const connection = message.connection;
		return connection === undefined
			? run()
			: message.owner === undefined
				? writer.withConnection(connection, run)
				: writer.connectionContext.runIssued(connection, owners.adopt(message.owner), run);
	});
}
