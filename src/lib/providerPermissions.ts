import {
  getProviderControl,
  getProviderManifest,
  isClaudePermissionId,
  type PermissionOption,
  type ProviderId,
} from "./providers";
import type { PermissionMode } from "./types";

export interface ProviderPermissionInputPresentation {
  option: PermissionOption;
  label: string;
  color: string;
}

export function getDefaultProviderPermissionId(provider: ProviderId): string {
  const manifest = getProviderManifest(provider);
  return manifest.defaultPermission || manifest.permissions[0]?.id || "default";
}

export function isProviderPermissionId(provider: ProviderId, id: string): boolean {
  return getProviderManifest(provider).permissions.some((permission) => permission.id === id);
}

export function getProviderPermissionOption(provider: ProviderId, id: string | null | undefined): PermissionOption {
  const manifest = getProviderManifest(provider);
  const defaultId = getDefaultProviderPermissionId(provider);
  return (
    manifest.permissions.find((permission) => permission.id === id) ??
    manifest.permissions.find((permission) => permission.id === defaultId) ??
    manifest.permissions[0]!
  );
}

export function getNextProviderPermissionId(provider: ProviderId, currentId: string): string {
  const permissions = getProviderManifest(provider).permissions;
  const currentIndex = permissions.findIndex((permission) => permission.id === currentId);
  return permissions[(currentIndex + 1) % permissions.length]?.id ?? getDefaultProviderPermissionId(provider);
}

export function getProviderPermissionInputPresentation(
  provider: ProviderId,
  permissionId: string | null | undefined,
): ProviderPermissionInputPresentation {
  const manifest = getProviderManifest(provider);
  const permissionControl = getProviderControl(provider, "permission");
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
