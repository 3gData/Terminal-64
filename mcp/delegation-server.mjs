#!/usr/bin/env node

// Terminal 64 Delegation MCP Server
// Provides team communication tools for delegated child agents.
// Communicates with the permission server's /delegation/ HTTP endpoints.
// Protocol: MCP over stdio (JSON-RPC 2.0)

import { startDelegationMcpServer } from "./delegation-common.mjs";

startDelegationMcpServer({
  serverName: "t64-delegation",
  stderrPrefix: "t64-delegation",
  requireDelegation: true,
  startupMessage: (context) => `Started for group ${context.groupId.slice(0, 8)} on port ${context.port}`,
});
