/**
 * Real RPC + TUI proof for cache-warm expected-ready notices.
 *
 * Run:
 *   node .agents/skills/senpi-qa/scripts/scenarios/cache-warm-ready-rpc-tui.mjs
 */
import { runCacheWarmReadyScenario } from "../lib/cache-warm-ready-scenario.mjs";

await runCacheWarmReadyScenario();
