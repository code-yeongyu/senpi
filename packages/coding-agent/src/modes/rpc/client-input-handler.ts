import type { AgentSession, PromptDisposition } from "../../core/agent-session.ts";
import { clientMessageIdentity } from "../../core/client-message-identity.ts";
import { UNKNOWN_COMMAND_CONFIRM_HINT, UnknownCommandError } from "../../core/unknown-command.ts";
import {
	type ClientMessageAdmission,
	ClientMessageIdConflict,
	type RpcClientInput,
} from "./client-admission-record.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { clientInputContext } from "./client-message-events.ts";
import { RPC_ERROR_UNKNOWN_COMMAND } from "./rpc-types.ts";

type InputOutput = {
	readonly output: (record: object) => void;
	readonly promptCalls: Set<Promise<unknown>>;
};

/** The same admission path serves classic stdio, shared sessions, and worker sessions. */
export async function handleClientInput(
	session: AgentSession,
	command: RpcClientInput,
	io: InputOutput,
): Promise<void> {
	try {
		const admissions = ClientAdmissions.forSession(session);
		let disposition: PromptDisposition | undefined;
		let responded = false;
		const respond = (admission: ClientMessageAdmission | undefined): void => {
			responded = true;
			io.output({
				id: command.id,
				type: "response",
				command: command.type,
				success: true,
				data: {
					disposition: admission?.disposition ?? disposition,
					...clientMessageIdentity(command),
					...(admission ? { admission } : {}),
				},
			});
		};
		const admission = await clientInputContext.run(clientMessageIdentity(command), () =>
			admissions.admit(command, async (hooks) => {
				switch (command.type) {
					case "prompt": {
						if (
							command.thinkingLevel !== undefined &&
							session.isStreaming &&
							command.streamingBehavior !== undefined
						) {
							throw new Error(
								"Cannot set thinkingLevel on a queued prompt; set it after the current turn completes.",
							);
						}
						const accepted = Promise.withResolvers<PromptDisposition>();
						let preflightSucceeded = false;
						let acceptedAdmission: ClientMessageAdmission | undefined;
						const call = session
							.prompt(command.message, {
								...clientMessageIdentity(command),
								images: command.images,
								streamingBehavior: command.streamingBehavior,
								thinkingLevel: command.thinkingLevel,
								sessionTitlePrompt: command.sessionTitlePrompt,
								expandPromptTemplates: command.expandPromptTemplates,
								unknownCommandAsText: command.unknownCommandAsText,
								source: "rpc",
								onQueuedInput: hooks.queued,
								promptDisposition: (next) => {
									disposition = next;
									acceptedAdmission = hooks.accepted(next);
								},
								preflightResult: (succeeded) => {
									if (succeeded && disposition !== undefined) {
										preflightSucceeded = true;
										accepted.resolve(disposition);
										respond(acceptedAdmission);
									}
								},
							})
							.catch((error: unknown) => {
								if (!preflightSucceeded) accepted.reject(error);
							});
						io.promptCalls.add(call);
						void call.finally(() => io.promptCalls.delete(call));
						return accepted.promise;
					}
					case "steer":
					case "follow_up": {
						const options = {
							...clientMessageIdentity(command),
							enqueueOrder: command.enqueueOrder,
							source: "rpc" as const,
							onQueuedInput: hooks.queued,
						};
						disposition =
							command.type === "steer"
								? await session.steer(command.message, command.images, options)
								: await session.followUp(command.message, command.images, options);
						hooks.accepted(disposition);
						return disposition;
					}
				}
			}),
		);
		if (!responded) respond(admission);
	} catch (error: unknown) {
		const unknownCommand = error instanceof UnknownCommandError;
		io.output({
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			error: unknownCommand
				? `${error.message} ${UNKNOWN_COMMAND_CONFIRM_HINT}`
				: error instanceof Error
					? error.message
					: String(error),
			...(error instanceof ClientMessageIdConflict ? { errorCode: error.code } : {}),
			...(unknownCommand
				? {
						errorCode: RPC_ERROR_UNKNOWN_COMMAND,
						errorData: { command: error.command, suggestions: error.suggestions, reason: error.reason },
					}
				: {}),
		});
	}
}
