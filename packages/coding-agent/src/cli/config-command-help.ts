import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { CONFIG_IMPORT_PI_USAGE } from "./config-import-pi.ts";

export const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

export function printConfigCommandHelp(): void {
	console.log(`${chalk.bold("Usage:")}
  ${CONFIG_COMMAND_USAGE}

Open the resource configuration TUI to enable or disable package resources.
Without -l, starts in global settings (~/${CONFIG_DIR_NAME}/agent/settings.json).
Press Tab in the TUI to switch between global and project-local modes.

Options:
  -l, --local       Edit project overrides (${CONFIG_DIR_NAME}/settings.json)
  -a, --approve     Trust project-local files for this command with -l
  -na, --no-approve Ignore project-local files for this command with -l

  ${APP_NAME} config agent-dir --json

Read the session engine's agent-directory selection without opening settings or starting a host.
Every outcome is one versioned JSON record: exit 0 for success, 2 for invalid arguments,
or 1 when the directory cannot be resolved. See docs/agent-directory-selection.md.

  ${CONFIG_IMPORT_PI_USAGE}

Copy config files you edited in ~/.pi/agent after its one-time copy into ~/${CONFIG_DIR_NAME}/agent,
saving each replaced file as <file>.bak-<time> first. Without file names, imports every edited file.
~/.pi/agent itself is only read.
`);
}
