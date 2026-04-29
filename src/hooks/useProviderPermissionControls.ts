import { useCallback, useEffect, useMemo } from "react";
import {
  getDefaultProviderPermissionId,
  getNextProviderPermissionId,
  getProviderPermissionOption,
  isProviderPermissionId,
  permissionModeFromProviderPermission,
} from "../lib/providerPermissions";
import {
  getProviderPermissionControlPolicy,
  type PermissionOption,
  type ProviderId,
} from "../lib/providers";
import type { PermissionMode } from "../lib/types";
import {
  getProviderPermissionId,
  resolveSessionProviderState,
  useClaudeStore,
} from "../stores/claudeStore";

export interface ProviderPermissionControls {
  permissionId: string;
  permission: PermissionOption;
  permissionMode: PermissionMode;
  cyclePermission: () => void;
  selectPermissionId: (permissionId: string, options?: { persist?: boolean }) => boolean;
}

interface UseProviderPermissionControlsArgs {
  sessionId: string;
  provider: ProviderId;
  skipPermissions: boolean;
}

function coerceProviderPermissionId(provider: ProviderId, permissionId: string | null | undefined): string {
  return isProviderPermissionId(provider, permissionId ?? "")
    ? permissionId!
    : getDefaultProviderPermissionId(provider);
}

export function useProviderPermissionControls({
  sessionId,
  provider,
  skipPermissions,
}: UseProviderPermissionControlsArgs): ProviderPermissionControls {
  const providerPermissionId = useClaudeStore((state) => {
    const providerState = resolveSessionProviderState(state.sessions[sessionId]);
    return getProviderPermissionId(providerState, provider);
  });

  useEffect(() => {
    const policy = getProviderPermissionControlPolicy(provider);
    if (skipPermissions && policy.skipPermissionId && isProviderPermissionId(provider, policy.skipPermissionId)) {
      useClaudeStore.getState().setProviderPermission(sessionId, provider, policy.skipPermissionId);
    }
  }, [provider, sessionId, skipPermissions]);

  const permissionId = useMemo(
    () => coerceProviderPermissionId(provider, providerPermissionId),
    [provider, providerPermissionId],
  );

  const permission = useMemo(
    () => getProviderPermissionOption(provider, permissionId),
    [provider, permissionId],
  );
  const permissionMode = permissionModeFromProviderPermission(permissionId);

  const selectPermissionId = useCallback(
    (nextPermissionId: string, _options?: { persist?: boolean }) => {
      if (!isProviderPermissionId(provider, nextPermissionId)) return false;
      useClaudeStore.getState().setProviderPermission(sessionId, provider, nextPermissionId);
      return true;
    },
    [provider, sessionId],
  );

  const cyclePermission = useCallback(() => {
    const nextPermissionId = getNextProviderPermissionId(provider, permissionId);
    selectPermissionId(nextPermissionId, { persist: true });
  }, [permissionId, provider, selectPermissionId]);

  return {
    permissionId,
    permission,
    permissionMode,
    cyclePermission,
    selectPermissionId,
  };
}
