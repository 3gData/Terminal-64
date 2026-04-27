import { useState } from "react";
import { getProviderManifest, type ProviderId } from "../../lib/providers";
import type { McpServer, PermissionMode } from "../../lib/types";
import type { McpServerStatus } from "../../stores/claudeStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "../ui/DropdownMenu";
import McpMenu from "./McpMenu";

type TopMenu = "mcp" | "model" | "effort" | null;

interface ProviderControlsProps {
  configuredMcpServers: McpServer[];
  liveMcpServers: McpServerStatus[] | undefined;
  provider: ProviderId;
  selectedModel: string;
  selectedEffort: string;
  onSelectModel: (id: string) => void;
  onSelectEffort: (id: string) => void;
  onMcpOpen: () => void;
}

interface ProviderPermissionInputArgs {
  provider: ProviderId;
  anthropicPermission: {
    id: PermissionMode;
    color: string;
  };
  codexPermissionId: string;
  onCycleAnthropicPermission: () => void;
  onCycleCodexPermission: () => void;
}

export interface ProviderPermissionInputProps {
  permLabel: string;
  permColor: string;
  onCyclePerm: () => void;
}

export function buildProviderPermissionInputProps({
  provider,
  anthropicPermission,
  codexPermissionId,
  onCycleAnthropicPermission,
  onCycleCodexPermission,
}: ProviderPermissionInputArgs): ProviderPermissionInputProps {
  const manifest = getProviderManifest(provider);
  const permissionIdByProvider: Record<ProviderId, string> = {
    anthropic: anthropicPermission.id,
    openai: codexPermissionId,
  };
  const cycleByProvider: Record<ProviderId, () => void> = {
    anthropic: onCycleAnthropicPermission,
    openai: onCycleCodexPermission,
  };
  const current = manifest.permissions.find((p) => p.id === permissionIdByProvider[provider]) ?? manifest.permissions[0]!;
  const label = current.inputLabel ?? current.label.toLowerCase();
  return {
    permLabel: `${label} ${manifest.ui.inputPermissionSuffix}`,
    permColor: current.color || anthropicPermission.color,
    onCyclePerm: cycleByProvider[provider],
  };
}

export default function ProviderControls({
  configuredMcpServers,
  liveMcpServers,
  provider,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
  onMcpOpen,
}: ProviderControlsProps) {
  const [openMenu, setOpenMenu] = useState<TopMenu>(null);
  const providerCfg = getProviderManifest(provider);
  const activeModels = providerCfg.models;
  const activeEfforts = providerCfg.efforts;
  const currentModel =
    activeModels.find((m) => m.id === selectedModel) || activeModels[0]!;
  const currentEffort =
    activeEfforts.find((e) => e.id === selectedEffort) || activeEfforts[2] || activeEfforts[0]!;

  return (
    <>
      {providerCfg.capabilities.mcp && (
        <McpMenu
          configuredServers={configuredMcpServers}
          liveServers={liveMcpServers}
          open={openMenu === "mcp"}
          onOpenChange={(open) => {
            setOpenMenu(open ? "mcp" : null);
            if (open) onMcpOpen();
          }}
        />
      )}

      <DropdownMenu open={openMenu === "model"} onOpenChange={(open) => setOpenMenu(open ? "model" : null)}>
        <DropdownMenuTrigger asChild>
          <button className="shadcn-trigger" aria-label="Model">
            {currentModel.label}
            <span className="shadcn-trigger-chev">▾</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{providerCfg.ui.modelMenuLabel}</DropdownMenuLabel>
          {activeModels.map((model) => (
            <DropdownMenuItem
              key={model.id}
              active={model.id === selectedModel}
              onSelect={() => onSelectModel(model.id)}
            >
              <span className="shadcn-menu-text">{model.label}</span>
              <span className="shadcn-menu-check">{model.id === selectedModel ? "✓" : ""}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu open={openMenu === "effort"} onOpenChange={(open) => setOpenMenu(open ? "effort" : null)}>
        <DropdownMenuTrigger asChild>
          <button className="shadcn-trigger" aria-label="Reasoning effort">
            {currentEffort.label}
            <span className="shadcn-trigger-chev">▾</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{providerCfg.ui.effortMenuLabel}</DropdownMenuLabel>
          {activeEfforts.map((effort) => (
            <DropdownMenuItem
              key={effort.id}
              active={effort.id === selectedEffort}
              onSelect={() => onSelectEffort(effort.id)}
            >
              <span className="shadcn-menu-text">{effort.label}</span>
              <span className="shadcn-menu-check">{effort.id === selectedEffort ? "✓" : ""}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
