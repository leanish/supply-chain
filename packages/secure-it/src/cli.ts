#!/usr/bin/env node
/**
 * secure-it run|review <owner/repo> [--config <agent.yaml>]: `run` fixes one
 * package the supply-chain gate's full scan fails on (every malicious package
 * together) and opens or updates its PR; `review` goes over secure-it's open
 * PRs (see packages/remediation). Usually started by `packages/remediation/run.sh`.
 */
import { runToolCommand } from "../../remediation/src/command.ts";

import { secureIt } from "./secure-it.ts";

process.exitCode = await runToolCommand(secureIt(), process.argv.slice(2));
