#!/usr/bin/env node
// Order is load-bearing: the sandbox environment is restored before any module reads it,
// then runtime setup owns process identity, Bun OAuth and the Bedrock provider module,
// then the fork's Cursor agent provider registers, and only then does the CLI dispatch.
import "./sandbox-env-setup.ts";
import "./runtime-setup.ts";

await import("./register-cursor-agent.ts");
await import("../cli-main.ts");
