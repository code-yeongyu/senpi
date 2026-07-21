import type { ThreadMetadataUpdateResponse } from "../protocol/index.ts";
import type { MethodHandler, MethodRegistry, RpcRequest } from "../rpc/registry.ts";
import type { ThreadArchiveState } from "./archive-state.ts";
import { objectValue, requiredString } from "./handler-params.ts";
import { ThreadMetadataState, ThreadMetadataUpdateError } from "./metadata-state.ts";
import { ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import type { TurnLog } from "./turn-log.ts";
import { invalidRequest } from "./turn-runtime.ts";
import { buildWireThread } from "./wire-thread.ts";

export interface ThreadMetadataHandlersOptions {
	readonly threads: ThreadRegistry;
	readonly turnLog: TurnLog;
	readonly archiveState: ThreadArchiveState;
}

type MetadataHandlerRegistration = {
	readonly method: string;
	readonly handler: MethodHandler;
};

export function registerThreadMetadataHandlers(registry: MethodRegistry, options: ThreadMetadataHandlersOptions): void {
	const handlers = new ThreadMetadataHandlers(options);
	for (const registration of handlers.registrations()) {
		registry.register(registration.method, {
			handler: registration.handler,
			scope: "thread",
		});
	}
}

class ThreadMetadataHandlers {
	private readonly threads: ThreadRegistry;
	private readonly turnLog: TurnLog;
	private readonly archiveState: ThreadArchiveState;
	private readonly metadataState = new ThreadMetadataState();

	constructor(options: ThreadMetadataHandlersOptions) {
		this.threads = options.threads;
		this.turnLog = options.turnLog;
		this.archiveState = options.archiveState;
	}

	registrations(): readonly MetadataHandlerRegistration[] {
		return [{ method: "thread/metadata/update", handler: (context) => this.update(context.request) }];
	}

	private async update(request: RpcRequest): Promise<ThreadMetadataUpdateResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		try {
			const archivedThread = await this.findArchivedThread(threadId);
			if (archivedThread) {
				await this.metadataState.updateGitInfo(archivedThread, params.gitInfo);
				return {
					thread: await buildWireThread({ ...archivedThread, status: { type: "notLoaded" } }, this.turnLog, false),
				};
			}

			const entry = await this.threads.resumeThread(threadId);
			await this.metadataState.updateGitInfo(this.threads.buildThread(entry), params.gitInfo);
			return { thread: await buildWireThread(entry, this.turnLog, false) };
		} catch (error) {
			if (error instanceof ThreadMetadataUpdateError) {
				throw invalidRequest(error.message);
			}
			if (error instanceof ThreadNotFoundError) {
				throw invalidRequest(`thread not found: ${threadId}`);
			}
			throw error;
		}
	}

	private async findArchivedThread(threadId: string) {
		return (await this.archiveState.listArchivedThreads()).find((thread) => thread.id === threadId);
	}
}
