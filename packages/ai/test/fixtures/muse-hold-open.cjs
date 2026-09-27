#!/usr/bin/env node
const { MessageChannel } = require("node:worker_threads");

process.stdout.write(`${JSON.stringify({ payload: { kind: "run_output_delta", text: "DONE" } })}\n`);
process.stdout.write(`${JSON.stringify({ payload: { kind: "run_terminal", terminal: "completed", text: "DONE", reason: null } })}\n`);

const channel = new MessageChannel();
channel.port1.on("message", () => {});
channel.port1.ref();
