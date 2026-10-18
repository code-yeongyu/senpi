import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import { McpTokenStore } from "../../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { createMcpExtension } from "../../../src/core/extensions/builtin/mcp/index.ts";
import { McpService } from "../../../src/core/extensions/builtin/mcp/service.ts";
import { createHarness } from "../../suite/harness.ts";

const agentDir = process.argv[2];
if (agentDir === undefined) throw new Error("missing isolated agent directory");
process.env[ENV_AGENT_DIR] = agentDir;
const originalRead = McpTokenStore.prototype.read;
McpTokenStore.prototype.read = function () {
	process.send?.({ event: "auth-read" });
	return originalRead.call(this);
};
const service = new McpService();
const harness = await createHarness({ extensionFactories: [createMcpExtension(service)] });
try {
	harness.setResponses([
		() => {
			process.send?.({ event: "first-request" });
			return fauxAssistantMessage("fixture response");
		},
	]);
	process.send?.({ event: "started" });
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	await service.refreshWireStatusSnapshot();
	await harness.session.prompt("first request while another process holds migration");
} finally {
	await service.dispose("quit");
	harness.cleanup();
	process.disconnect?.();
}
