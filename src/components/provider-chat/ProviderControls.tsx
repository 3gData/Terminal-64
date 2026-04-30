import { useState } from "react";
import {
  type ProviderControlId,
  type ProviderControlValue,
  type ProviderId,
} from "../../lib/providers";
import { getProviderPermissionInputPresentation } from "../../lib/providerPermissions";
import {
  getProviderSnapshotPermissionInputPresentation,
  listProviderSnapshotControls,
  providerSnapshotOptionValue,
  providerSnapshotSupports,
  useProviderSnapshots,
  type ProviderSnapshotControl,
  type ProviderSnapshotMap,
} from "../../lib/providerSnapshots";
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
  selectedControls: Record<string, ProviderControlValue>;
  onSelectControl: (controlId: ProviderControlId, value: ProviderControlValue) => void;
  onMcpOpen: () => void;
}

interface ProviderPermissionInputArgs {
  provider: ProviderId;
  permissionId: string;
  onCyclePermission: () => void;
  snapshots?: ProviderSnapshotMap | undefined;
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
  snapshots,
}: ProviderPermissionInputArgs): ProviderPermissionInputProps {
  const presentation =
    getProviderSnapshotPermissionInputPresentation(provider, permissionId, snapshots)
    ?? getProviderPermissionInputPresentation(provider, permissionId);
  return {
    permLabel: presentation.label,
    permColor: presentation.color,
    onCyclePerm: onCyclePermission,
  };
}

function selectedValueForControl(
  control: ProviderSnapshotControl,
  selectedControls: Record<string, ProviderControlValue>,
): ProviderControlValue {
  return selectedControls[control.id] ?? control.defaultValue;
}

function renderControlValue(value: ProviderControlValue): string {
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return value ?? "";
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
  const snapshots = useProviderSnapshots();
  const topbarControls = listProviderSnapshotControls(provider, snapshots, "topbar");

  return (
    <>
      {providerSnapshotSupports(provider, "mcp", snapshots) && (
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
        const selectedValue = selectedValueForControl(control, selectedControls);
        if (control.kind === "boolean") {
          const checked = typeof selectedValue === "boolean"
            ? selectedValue
            : typeof control.defaultValue === "boolean" && control.defaultValue;
          return (
            <button
              key={control.id}
              className="shadcn-trigger"
              aria-label={control.label}
              aria-pressed={checked}
              onClick={() => onSelectControl(control.id, !checked)}
            >
              {control.label}: {checked ? "On" : "Off"}
            </button>
          );
        }

        if (control.kind === "text") {
          return (
            <input
              key={control.id}
              className="shadcn-trigger"
              aria-label={control.label}
              value={typeof selectedValue === "string" ? selectedValue : renderControlValue(control.defaultValue)}
              onChange={(event) => onSelectControl(control.id, event.currentTarget.value)}
            />
          );
        }

        if (control.kind === "number") {
          const value = typeof selectedValue === "number"
            ? selectedValue
            : typeof control.defaultValue === "number"
              ? control.defaultValue
              : 0;
          return (
            <input
              key={control.id}
              className="shadcn-trigger"
              type="number"
              aria-label={control.label}
              value={Number.isFinite(value) ? value : ""}
              onChange={(event) => {
                const next = Number(event.currentTarget.value);
                if (Number.isFinite(next)) onSelectControl(control.id, next);
              }}
            />
          );
        }

        const currentOption =
          control.options.find((option) => Object.is(providerSnapshotOptionValue(option), selectedValue))
          ?? control.options[0];
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
                  active={Object.is(providerSnapshotOptionValue(option), selectedValue)}
                  onSelect={() => onSelectControl(control.id, providerSnapshotOptionValue(option))}
                >
                  <span className="shadcn-menu-text">{option.label}</span>
                  <span className="shadcn-menu-check">
                    {Object.is(providerSnapshotOptionValue(option), selectedValue) ? "✓" : ""}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      })}
    </>
  );
}
