#!/usr/bin/env node

// Terminal 64 MCP Server
// Always-on MCP for every T64 Claude session.
// Delegation tools (send_to_team, read_team, report_done) are only
// exposed when T64_DELEGATION_PORT + T64_GROUP_ID are set.
// Protocol: MCP over stdio (JSON-RPC 2.0)

import { startDelegationMcpServer } from "./delegation-common.mjs";

startDelegationMcpServer({
  serverName: "terminal-64",
  stderrPrefix: "t64",
  selfTest: true,
});
