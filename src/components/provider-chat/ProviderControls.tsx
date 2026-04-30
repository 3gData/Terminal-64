import { useState } from "react";
import {
  getProviderManifest,
  listProviderControls,
  type ProviderControlId,
  type ProviderId,
} from "../../lib/providers";
import { getProviderPermissionInputPresentation } from "../../lib/providerPermissions";
import type { McpServer } from "../../lib/types";
import type { McpServerStatus } from "../../stores/providerSessionStore";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "../ui/DropdownMenu";
import McpMenu from "./McpMenu";

type TopMenu = "mcp" | ProviderControlId | null;

interface ProviderControlsProps {
  configuredMcpServers: McpServer[];
  liveMcpServers: McpServerStatus[] | undefined;
  provider: ProviderId;
  selectedControls: Record<string, string | null>;
  onSelectControl: (controlId: ProviderControlId, value: string) => void;
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
  selectedControls,
  onSelectControl,
  onMcpOpen,
}: ProviderControlsProps) {
  const [openMenu, setOpenMenu] = useState<TopMenu>(null);
  const providerCfg = getProviderManifest(provider);
  const topbarControls = listProviderControls(provider, "topbar");

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

      {topbarControls.map((control) => {
        const selectedValue = selectedControls[control.id] ?? control.defaultValue;
        const currentOption =
          control.options.find((option) => option.id === selectedValue) ?? control.options[0];
        if (!currentOption || control.options.length === 0) return null;
        return (
          <DropdownMenu
            key={control.id}
            open={openMenu === control.id}
            onOpenChange={(open) => setOpenMenu(open ? control.id : null)}
          >
            <DropdownMenuTrigger asChild>
              <button className="shadcn-trigger" aria-label={control.label}>
                {currentOption.label}
                <span className="shadcn-trigger-chev">▾</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{control.label}</DropdownMenuLabel>
              {control.options.map((option) => (
                <DropdownMenuItem
                  key={option.id}
                  active={option.id === selectedValue}
                  onSelect={() => onSelectControl(control.id, option.id)}
                >
                  <span className="shadcn-menu-text">{option.label}</span>
                  <span className="shadcn-menu-check">{option.id === selectedValue ? "✓" : ""}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
}
