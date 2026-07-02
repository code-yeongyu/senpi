import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, type RegistryConnection } from "../../../src/modes/app-server/rpc/registry.ts";
import {
	NotificationRouter,
	type RoutableConnection,
	type RouterNotification,
} from "../../../src/modes/app-server/server/notifications.ts";
import { registerThreadLifecycleHandlers } from "../../../src/modes/app-server/threads/handlers.ts";
import { ThreadRegistry } from "../../../src/modes/app-server/threads/registry.ts";
import { TurnLog } from "../../../src/modes/app-server/threads/turn-log.ts";

class FakeConnection implements RoutableConnection, RegistryConnection {
	readonly id = "qa-conn";
	readonly transport = "ws";
	readonly capabilities = { experimentalApi: true };
	readonly received: RouterNotification[] = [];
	initialized = true;
	optOutNotificationMethods: readonly string[] | null = null;

	send(notification: RouterNotification): void {
		this.received.push(notification);
	}
}

const scratchRoot = join(tmpdir(), `senpi-qa-task12-resume-unknown-${process.pid}`);
const unknownThreadId = "11111111-1111-1111-1111-111111111111";

async function main(): Promise<void> {
	rmSync(scratchRoot, { recursive: true, force: true });
	let runError: unknown;
	try {
		const connection = new FakeConnection();
		const registry = createRegistry();
		registerThreadLifecycleHandlers(registry, {
			threads: new ThreadRegistry({
				agentDir: join(scratchRoot, "agent"),
				sessionDir: join(scratchRoot, "sessions"),
			}),
			turnLog: new TurnLog(),
			notifications: new NotificationRouter({ connections: [connection] }),
			idleUnloadMinutes: 10,
		});
		const response = await registry.dispatch(connection, {
			id: 1,
			method: "thread/resume",
			params: { threadId: unknownThreadId },
		});
		const message = "error" in response ? response.error.message : "NO_ERROR";
		console.log(`RESUME_UNKNOWN=${message}`);
		if (message !== `no rollout found for thread id ${unknownThreadId}`) {
			throw new Error(`unexpected resume error: ${message}`);
		}
	} catch (error) {
		if (error instanceof Error) {
			runError = error;
		} else {
			throw error;
		}
	}
	rmSync(scratchRoot, { recursive: true, force: true });
	if (existsSync(scratchRoot)) {
		throw new Error(`cleanup failed: ${scratchRoot}`);
	}
	console.log(`CLEANUP=removed:${scratchRoot}`);
	if (runError) {
		throw runError;
	}
}

await main();
