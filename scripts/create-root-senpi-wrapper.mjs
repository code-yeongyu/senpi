import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const distDir = join(process.cwd(), "dist");
const wrapperPath = join(distDir, "senpi");

mkdirSync(distDir, { recursive: true });
writeFileSync(
	wrapperPath,
	`#!/usr/bin/env node
import "../packages/coding-agent/dist/cli.js";
`,
	"utf8",
);
chmodSync(wrapperPath, 0o755);

const globalPrefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim();
const globalBinDir = join(globalPrefix, "bin");
const globalShimPath = join(globalBinDir, "senpi");

mkdirSync(globalBinDir, { recursive: true });
writeFileSync(
	globalShimPath,
	`#!/bin/sh
exec "${wrapperPath}" "$@"
`,
	"utf8",
);
chmodSync(globalShimPath, 0o755);
