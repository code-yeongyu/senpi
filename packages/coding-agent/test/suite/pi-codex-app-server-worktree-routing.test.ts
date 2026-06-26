import { describe, expect, it } from "vitest";
import { createIdMapper } from "../../src/core/extensions/builtin/pi-codex-app-server/id-mapper.ts";
import { createRequestRouter } from "../../src/core/extensions/builtin/pi-codex-app-server/request-router.ts";
import { createSessionRegistry } from "../../src/core/extensions/builtin/pi-codex-app-server/session-registry.ts";
import { RecordingAppServerClient } from "./pi-codex-app-server-routing-fakes.ts";

describe("pi-codex-app-server worktree routing", () => {
	it("preserves external repository and worktree metadata when starting a session", async () => {
		// given
		const client = new RecordingAppServerClient([{ thread: { id: "app-thread-1", session_id: "app-session-1" } }]);
		const router = createRequestRouter({
			client,
			idMapper: createIdMapper(),
			sessionRegistry: createSessionRegistry(),
		});
		const appParams = {
			cwd: "/Users/yeongyu/local-workspaces/pi-webfetch-tistory-worktree",
			environments: [
				{
					id: "external-worktree",
					cwd: "/Users/yeongyu/local-workspaces/pi-webfetch-tistory-worktree",
				},
			],
			runtime_workspace_roots: ["/Users/yeongyu/local-workspaces/pi-webfetch-tistory-worktree"],
			runtimeWorkspaceRoots: ["/Users/yeongyu/local-workspaces/pi-webfetch-tistory-worktree"],
			selectedCapabilityRoots: ["/Users/yeongyu/local-workspaces/pi-webfetch-tistory-worktree"],
		};

		// when
		await router.route({
			method: "session/new",
			externalRequestId: "external-worktree-request",
			params: {
				externalSessionId: "external-worktree-session",
				appParams,
			},
		});

		// then
		expect(client.calls).toEqual([{ method: "thread/start", params: appParams }]);
	});
});
