import { useMemo } from "react";
import type { McpServer } from "../../lib/types";
import type { McpServerStatus } from "../../stores/providerSessionStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "../ui/DropdownMenu";

type McpDisplayServer = McpServerStatus | McpServer;

interface McpMenuProps {
  configuredServers: McpServer[];
  liveServers: McpServerStatus[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function isBuiltInMcp(name: string): boolean {
  return name === "terminal-64" || name === "t64" || name === "codex/terminal-64";
}

function mcpDisplayKey(server: McpDisplayServer): string {
  return isBuiltInMcp(server.name) ? "terminal-64" : server.name;
}

function mcpStatusRank(server: McpDisplayServer): number {
  if (!("status" in server)) return 0;
  switch (server.status) {
    case "connected":
    case "ready":
      return 4;
    case "starting":
      return 3;
    case "failed":
    case "error":
      return 2;
    default:
      return 1;
  }
}

function mergeMcpDisplayServers(configured: McpServer[], live: McpServerStatus[] | undefined): McpDisplayServer[] {
  const merged = new Map<string, McpDisplayServer>();
  for (const server of configured) {
    const key = mcpDisplayKey(server);
    if (!merged.has(key)) {
      merged.set(key, { ...server, name: key === "terminal-64" ? "terminal-64" : server.name });
    }
  }
  for (const server of live ?? []) {
    const key = mcpDisplayKey(server);
    const previous = merged.get(key);
    const next: McpDisplayServer = {
      ...previous,
      ...server,
      name: key === "terminal-64" ? "terminal-64" : server.name,
    };
    const transport = ("transport" in server ? server.transport : undefined) ?? (previous && "transport" in previous ? previous.transport : undefined);
    if (transport) next.transport = transport;
    const scope = ("scope" in server ? server.scope : undefined) ?? (previous && "scope" in previous ? previous.scope : undefined);
    if (scope) next.scope = scope;
    const shouldReplace = !previous || mcpStatusRank(next) >= mcpStatusRank(previous) || server.name === "terminal-64";
    if (shouldReplace) merged.set(key, next);
  }
  return Array.from(merged.values());
}

export default function McpMenu({ configuredServers, liveServers, open, onOpenChange }: McpMenuProps) {
  const servers = useMemo(
    () => mergeMcpDisplayServers(configuredServers, liveServers),
    [configuredServers, liveServers],
  );
  const userMcp = servers.filter((server) => !isBuiltInMcp(server.name));
  const hasError = servers.some(
    (server) => "status" in server && (server.status === "failed" || server.status === "error"),
  );

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          className={`shadcn-trigger ${userMcp.length > 0 ? "cc-mcp-btn--active" : ""} ${hasError ? "cc-mcp-btn--error" : ""}`}
          aria-label="MCP servers"
        >
          MCP{userMcp.length > 0 ? ` (${userMcp.length})` : ""}
          <span className="shadcn-trigger-chev">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="cc-mcp-menu">
        <DropdownMenuLabel>MCP Servers</DropdownMenuLabel>
        {servers.length === 0 ? (
          <div className="cc-mcp-empty" style={{ padding: "6px 10px", fontSize: 10, color: "var(--fg-muted, #6c7086)" }}>
            No MCP servers configured
          </div>
        ) : (
          servers.map((server) => {
            const isLive = "status" in server;
            const status = (isLive ? server.status : undefined) || "configured";
            const isError = status === "failed" || status === "error";
            const isConnected = status === "connected";
            const isBuiltIn = isBuiltInMcp(server.name);
            const liveServer = isLive ? server : undefined;
            const toolCount = liveServer?.toolCount ?? liveServer?.tools?.length;
            return (
              <DropdownMenuItem
                key={mcpDisplayKey(server)}
                className={`shadcn-menu-item--mcp ${isBuiltIn ? "cc-mcp-item--builtin" : ""}`}
                onSelect={(e) => e.preventDefault()}
              >
                <div className="shadcn-mcp-row">
                  <span className={`shadcn-mcp-dot ${isError ? "shadcn-mcp-dot--error" : isConnected ? "shadcn-mcp-dot--ok" : "shadcn-mcp-dot--idle"}`} />
                  <span className="shadcn-mcp-name">{isBuiltIn ? "T64" : server.name}</span>
                </div>
                <span className="shadcn-mcp-meta">
                  {status}
                  {isBuiltIn ? " · built-in" : ""}
                  {server.transport ? ` · ${server.transport}` : ""}
                  {server.scope ? ` · ${server.scope}` : ""}
                  {toolCount != null ? ` · ${toolCount} tool${toolCount !== 1 ? "s" : ""}` : ""}
                </span>
                {isError && liveServer?.error && (
                  <span className="shadcn-mcp-error">{liveServer.error}</span>
                )}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
