#!/usr/bin/env node
// The interpreted tool child's entry: only the role bootstrap, so the child never loads (or parses) the CLI graph.
import "./internal-role.ts";

process.stderr.write("tool-child: no internal role in the environment\n");
process.exit(70);
