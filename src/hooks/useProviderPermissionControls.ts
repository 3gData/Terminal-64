import { useCallback, useMemo, useState } from "react";
import {
  getDefaultProviderPermissionId,
  getNextProviderPermissionId,
  getProviderPermissionOption,
  isProviderPermissionId,
  permissionModeFromProviderPermission,
} from "../lib/providerPermissions";
import {
  getProviderManifest,
  getProviderPermissionControlPolicy,
  isClaudePermissionId,
  type PermissionOption,
  type ProviderId,
} from "../lib/providers";
import type { PermissionMode } from "../lib/types";
import {
  getOpenAiProviderSessionMetadata,
  resolveSessionProviderState,
  useClaudeStore,
} from "../stores/claudeStore";
import { useSettingsStore } from "../stores/settingsStore";

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

function initialSettingsPermissionId(skipPermissions: boolean): PermissionMode {
  const manifest = getProviderManifest("anthropic");
  const policy = getProviderPermissionControlPolicy("anthropic");
  if (skipPermissions && policy.skipPermissionId && isClaudePermissionId(policy.skipPermissionId)) {
    return policy.skipPermissionId;
  }

  const settings = useSettingsStore.getState();
  const candidate = settings.claudeDefaultPermMode ?? settings.claudePermMode ?? manifest.defaultPermission;
  if (isClaudePermissionId(candidate)) return candidate;
  return isClaudePermissionId(manifest.defaultPermission) ? manifest.defaultPermission : "default";
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
  const [settingsPermissionId, setSettingsPermissionId] = useState<PermissionMode>(() =>
    initialSettingsPermissionId(skipPermissions),
  );
  const providerMetadataPermissionId = useClaudeStore((state) => {
    const providerState = resolveSessionProviderState(state.sessions[sessionId]);
    return getOpenAiProviderSessionMetadata(providerState)?.selectedCodexPermission ?? null;
  });

  const permissionId = useMemo(() => {
    const policy = getProviderPermissionControlPolicy(provider);
    if (policy.persistence === "settings") {
      return coerceProviderPermissionId(provider, settingsPermissionId);
    }
    return coerceProviderPermissionId(provider, providerMetadataPermissionId);
  }, [provider, providerMetadataPermissionId, settingsPermissionId]);

  const permission = useMemo(
    () => getProviderPermissionOption(provider, permissionId),
    [provider, permissionId],
  );
  const permissionMode = permissionModeFromProviderPermission(permissionId, settingsPermissionId);

  const selectPermissionId = useCallback(
    (nextPermissionId: string, options?: { persist?: boolean }) => {
      if (!isProviderPermissionId(provider, nextPermissionId)) return false;
      const policy = getProviderPermissionControlPolicy(provider);
      if (policy.persistence === "settings") {
        const nextMode = permissionModeFromProviderPermission(nextPermissionId);
        setSettingsPermissionId(nextMode);
        if (options?.persist) {
          const settings = useSettingsStore.getState();
          if (!settings.claudeDefaultPermMode) {
            settings.set({ claudePermMode: nextMode });
          }
        }
        return true;
      }

      useClaudeStore.getState().setSelectedCodexPermission(sessionId, nextPermissionId);
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
