import * as config from "../../config.ts";
import * as killGuard from "../../core/kill-guard/index.ts";
import * as pendingInput from "../../core/pending-input-public.ts";
import * as engine from "../../engine/index.ts";
import * as engineTrust from "../../engine-trust/index.ts";
import * as modelCoverage from "../../model-coverage.ts";
import * as hostProbe from "../../modes/rpc/host-probe.ts";
import * as sessionWorkerData from "../../modes/rpc/session-worker-data.ts";
import * as supervisorRoute from "../../modes/rpc/supervisor-route.ts";
import * as presenterAuthority from "../../presenter-authority-slot.ts";
import * as privateFds from "../../private-fds.ts";
import * as subscriptionEgress from "../../subscription-egress/index.ts";
import * as toolsCore from "../../tools-core.ts";
import * as mcpEnvGrants from "./builtin/mcp/env-grants-store.ts";
import * as promptPresets from "./builtin/prompt-preset/public.ts";

/**
 * The host's own instance of every `@code-yeongyu/senpi/<subpath>` library export, for the extension loader's virtual
 * modules. Without an entry, an extension importing a subpath inside a bundled or compiled senpi resolved the
 * package's per-file `dist/` copy: a second module instance with its own module state and classes.
 *
 * Every `exports` subpath is listed here except the programs and launcher entries, which run on import or exist only for
 * a launcher that has not started the engine yet: `./rpc-entry`, `./program-resume-startup`, `./cli`, `./valid-cwd`,
 * `./private-fd-startup-release`, `./session-worker`, `./kill-guard-command`, and `./bun-runtime` (Bun-only modules for a
 * standalone Bun isolate); `./client` is the unpublished remote client and `./runtime-manifest.json` is data. The root
 * `.` is the loader's own `index.ts` entry.
 */
export const SENPI_SUBPATH_MODULES: Record<string, Record<string, unknown>> = {
	"@code-yeongyu/senpi/config": config,
	"@code-yeongyu/senpi/engine": engine,
	"@code-yeongyu/senpi/engine-trust": engineTrust,
	"@code-yeongyu/senpi/host-probe": hostProbe,
	"@code-yeongyu/senpi/kill-guard": killGuard,
	"@code-yeongyu/senpi/mcp-env-grants": mcpEnvGrants,
	"@code-yeongyu/senpi/model-coverage": modelCoverage,
	"@code-yeongyu/senpi/pending-input": pendingInput,
	"@code-yeongyu/senpi/presenter-authority": presenterAuthority,
	"@code-yeongyu/senpi/private-fds": privateFds,
	"@code-yeongyu/senpi/prompt-presets": promptPresets,
	"@code-yeongyu/senpi/session-worker-data": sessionWorkerData,
	"@code-yeongyu/senpi/subscription-egress": subscriptionEgress,
	"@code-yeongyu/senpi/supervisor-route": supervisorRoute,
	"@code-yeongyu/senpi/tools-core": toolsCore,
};
