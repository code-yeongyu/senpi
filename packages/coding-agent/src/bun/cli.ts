#!/usr/bin/env node
// Order is load-bearing: the sandbox environment is restored before any module reads it,
// then read-only metadata can answer before provider registration. Normal runs still
// set up process identity and providers before loading the full CLI.
import "./sandbox-env-setup.ts";
// The private descriptor table is captured right after the environment exists, before anything spawns.
import "../private-fds.ts";
import "../modes/rpc/internal-bootstrap.ts";
import { dispatchAgentDirectoryCommand } from "../cli/agent-dir-command.ts";

await dispatchAgentDirectoryCommand(process.argv.slice(2));

// Documented lazy boundary: metadata queries must not register every provider just to choose a store.
await import("./runtime-setup.ts");
await import("../cli-main.ts");
