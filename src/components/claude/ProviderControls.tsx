import { useState } from "react";
import { getProviderManifest, type ProviderId } from "../../lib/providers";
import { getProviderPermissionInputPresentation } from "../../lib/providerPermissions";
import type { McpServer } from "../../lib/types";
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
  permissionId: string;
  onCyclePermission: () => void;
}

export interface ProviderPermissionInputProps {
  permLabel: string;
  permColor: string;
  onCyclePerm: () => void;
}

export function buildProviderPermissionInputProps({
  provider,
  permissionId,
  onCyclePermission,
}: ProviderPermissionInputArgs): ProviderPermissionInputProps {
  const presentation = getProviderPermissionInputPresentation(provider, permissionId);
  return {
    permLabel: presentation.label,
    permColor: presentation.color,
    onCyclePerm: onCyclePermission,
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
