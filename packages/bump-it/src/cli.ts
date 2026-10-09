#!/usr/bin/env node
/** Usually started by packages/remediation/run.sh: weekly run, review every few hours. */
import { runToolCommand } from "../../remediation/src/command.ts";
import { bumpIt } from "./bump-it.ts";

process.exitCode = await runToolCommand(bumpIt(), process.argv.slice(2));
