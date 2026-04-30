import {
  getProviderDefaultPermission,
  getProviderInputPermissionControl,
  getProviderManifest,
  getProviderPermissionOptions,
  isClaudePermissionId,
  isProviderPermissionValue,
  type PermissionOption,
  type ProviderId,
} from "./providers";
import type { PermissionMode } from "./types";

export interface ProviderPermissionInputPresentation {
  option: PermissionOption;
  label: string;
  color: string;
}

function fallbackPermissionOption(id: string): PermissionOption {
  return {
    id,
    label: id === "default" ? "Default" : id,
    color: "#89b4fa",
    desc: "Provider default",
  };
}

export function getDefaultProviderPermissionId(provider: ProviderId): string {
  return getProviderDefaultPermission(provider) || getProviderPermissionOptions(provider)[0]?.id || "default";
}

export function isProviderPermissionId(provider: ProviderId, id: string): boolean {
  return isProviderPermissionValue(provider, id);
}

export function getProviderPermissionOption(provider: ProviderId, id: string | null | undefined): PermissionOption {
  const permissions = getProviderPermissionOptions(provider);
  const defaultId = getDefaultProviderPermissionId(provider);
  return (
    permissions.find((permission) => permission.id === id) ??
    permissions.find((permission) => permission.id === defaultId) ??
    permissions[0] ??
    fallbackPermissionOption(defaultId)
  );
}

export function getNextProviderPermissionId(provider: ProviderId, currentId: string): string {
  const permissions = getProviderPermissionOptions(provider);
  if (permissions.length === 0) return getDefaultProviderPermissionId(provider);
  const currentIndex = permissions.findIndex((permission) => permission.id === currentId);
  return permissions[(currentIndex + 1) % permissions.length]?.id ?? getDefaultProviderPermissionId(provider);
}

export function getProviderPermissionInputPresentation(
  provider: ProviderId,
  permissionId: string | null | undefined,
): ProviderPermissionInputPresentation {
  const manifest = getProviderManifest(provider);
  const permissionControl = getProviderInputPermissionControl(provider);
  const option = getProviderPermissionOption(provider, permissionId);
  const label = option.inputLabel ?? option.label.toLowerCase();
  return {
    option,
    label: `${label} ${permissionControl?.inputSuffix ?? manifest.ui.inputPermissionSuffix}`,
    color: option.color,
  };
}

export function permissionModeFromProviderPermission(
  permissionId: string | null | undefined,
  fallback: PermissionMode = "default",
): PermissionMode {
  return permissionId && isClaudePermissionId(permissionId) ? permissionId : fallback;
}
