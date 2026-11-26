// The judge entry the runtime shims run under Node or Bun for an npm or source install (senpi#5349, L2); the compiled
// binary reaches the same check through its hidden `__kill-guard` subcommand instead.
import { runKillGuardCheckCommand } from "./check-command.ts";

process.exitCode = runKillGuardCheckCommand();
