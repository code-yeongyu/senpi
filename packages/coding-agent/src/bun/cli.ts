#!/usr/bin/env node
// Order is load-bearing: the sandbox environment is restored before any module reads it,
// then runtime setup owns process identity and bundled provider/OAuth registration,
// and only then does the CLI dispatch.
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";

await import("../cli-main.ts");
