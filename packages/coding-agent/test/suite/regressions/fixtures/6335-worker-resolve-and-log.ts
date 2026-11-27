import { parentPort, workerData } from "node:worker_threads";
import { resolveConfigReference } from "../../../../src/core/config-reference-resolver.ts";
import { createCompactionLogger, flushCompactionLogs } from "../../../../src/core/extensions/builtin/compaction/log.ts";
import { createConfigReloadLogger } from "../../../../src/core/extensions/builtin/config-reload/log.ts";
import { flushGuardLog, logGuardEvent } from "../../../../src/core/extensions/builtin/moved-path-guard/guard-log.ts";
import { createSessionLogger } from "../../../../src/core/session-log.ts";

const { agentDir, name, value } = workerData as { agentDir: string; name: string; value: string };

const resolved = await resolveConfigReference(
	{ $env: name },
	{ origin: `${agentDir}/models.json`, authority: "trusted", field: "providers.synthetic.apiKey" },
	{ [name]: value },
);
const text = `provider rejected key ${resolved}`;
createSessionLogger(agentDir, { mirrorToStderr: false }).warn("provider_failed", { error: text, cause: text });
createConfigReloadLogger(agentDir).warn("reload_deferred", { reason: text });
createCompactionLogger(agentDir, { mirrorToStderr: false }).info("summary_failed", { reason: text });
logGuardEvent("warn", "breadcrumb_ignored", { reason: text });
await Promise.all([flushCompactionLogs(), flushGuardLog()]);
parentPort?.postMessage("logged");
