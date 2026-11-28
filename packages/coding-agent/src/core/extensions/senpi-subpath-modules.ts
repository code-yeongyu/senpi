import * as pendingInput from "../../core/pending-input-public.ts";
import * as engine from "../../engine/index.ts";
import * as engineTrust from "../../engine-trust/index.ts";
import * as sessionWorkerData from "../../modes/rpc/session-worker-data.ts";
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
 * Every `exports` subpath is listed here except the ones that are programs, not libraries: `./rpc-entry` and
 * `./program-resume-startup` run on import, `./bun-runtime` registers Bun-only modules in a standalone Bun isolate,
 * and `./client` is the unpublished remote client. The root `.` is the loader's own `index.ts` entry.
 */
export const SENPI_SUBPATH_MODULES: Record<string, Record<string, unknown>> = {
	"@code-yeongyu/senpi/engine": engine,
	"@code-yeongyu/senpi/engine-trust": engineTrust,
	"@code-yeongyu/senpi/mcp-env-grants": mcpEnvGrants,
	"@code-yeongyu/senpi/pending-input": pendingInput,
	"@code-yeongyu/senpi/presenter-authority": presenterAuthority,
	"@code-yeongyu/senpi/private-fds": privateFds,
	"@code-yeongyu/senpi/prompt-presets": promptPresets,
	"@code-yeongyu/senpi/session-worker-data": sessionWorkerData,
	"@code-yeongyu/senpi/subscription-egress": subscriptionEgress,
	"@code-yeongyu/senpi/tools-core": toolsCore,
};
