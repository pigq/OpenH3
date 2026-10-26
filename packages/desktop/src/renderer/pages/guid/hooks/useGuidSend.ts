/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { getGuidDraftScope, getGuidTemplateSnapshot } from './useGuidDraft';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { type ChatFileRef, chatFileRefPath } from '@/common/types/chatFile';
import {
  isBuiltinImageGenerationName,
  isBuiltinVideoMediaName,
  type IMcpServer,
  type TProviderWithModel,
} from '@/common/config/storage';
import {
  creationMessage,
  creationSessionServers,
  type CreationModel,
  type CreationRequest,
} from '@/common/chat/document/creation/creation';
import { ensureBackendMcpCatalog, toSessionMcpServer } from '@/renderer/hooks/mcp/catalog';
import { emitter } from '@/renderer/utils/emitter';
import { updateWorkspaceTime } from '@/renderer/utils/workspace/workspaceHistory';
import { Message } from '@arco-design/web-react';
import { useCallback, useRef } from 'react';
import { type TFunction } from 'i18next';
import type { NavigateFunction } from 'react-router-dom';
import { mutate as swrMutate } from 'swr';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { comfyFamilyDetails, writeComfyDraftIntent, type ComfyDraftIntent } from '../Creation/comfyDraft';

export type GuidSendDeps = {
  creationModel?: CreationModel;
  creationIntent?: ComfyDraftIntent;
  // Input state
  input: string;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  files: ChatFileRef[];
  setFiles: React.Dispatch<React.SetStateAction<ChatFileRef[]>>;
  dir: string;
  setDir: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  loading: boolean;

  // Assistant state
  selectedAssistantId: string | null;
  selectedAssistantBackend: string;
  selectedMode: string;
  selectedAcpModel: string | null;
  selectedThoughtLevelValue?: string;
  current_model: TProviderWithModel | undefined;

  guidDisabledBuiltinSkills: string[] | undefined;
  guidEnabledSkills: string[] | undefined;
  assistantDefaultSkillIds?: string[];
  assistantDefaultDisabledBuiltinSkillIds?: string[];
  availableMcpServers: IMcpServer[];
  selectedMcpServerIds: string[] | undefined;
  assistantDefaultMcpIds?: string[];
  isGoogleAuth: boolean;

  // Mention state reset
  setMentionOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionQuery: React.Dispatch<React.SetStateAction<string | null>>;
  setMentionSelectorOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setMentionActiveIndex: React.Dispatch<React.SetStateAction<number>>;

  // Navigation
  navigate: NavigateFunction;
  t: TFunction;
  localeKey: string;
};

export type GuidSendResult = {
  handleSend: () => Promise<boolean>;
  sendMessageHandler: () => void;
  isButtonDisabled: boolean;
};

/**
 * Hook that manages the send logic for ACP and OpenH3 Core conversations.
 */
export const useGuidSend = (deps: GuidSendDeps): GuidSendResult => {
  const {
    creationModel,
    creationIntent,
    input,
    files,
    setFiles,
    dir,
    setDir,
    setLoading,
    loading,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    current_model,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    assistantDefaultSkillIds,
    assistantDefaultDisabledBuiltinSkillIds,
    availableMcpServers,
    selectedMcpServerIds,
    assistantDefaultMcpIds,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    navigate,
    t,
    localeKey,
  } = deps;
  const sendingRef = useRef(false);

  const handleSend = useCallback(async () => {
    const guidDraftScope = getGuidDraftScope();
    if (!guidDraftScope) return false;
    if (!selectedAssistantId) {
      return false;
    }

    const isCustomWorkspace = !!dir;
    const finalWorkspace = dir || '';

    const assistantConversationId = selectedAssistantId;
    const assistantBackend = selectedAssistantBackend;
    const enabled_skills_to_send = guidEnabledSkills ?? assistantDefaultSkillIds;
    const excludeBuiltinSkills = guidDisabledBuiltinSkills ?? assistantDefaultDisabledBuiltinSkillIds;
    const selectedAllMcpServerIds = selectedMcpServerIds ?? [];
    const selectedMcpServerIdSet = new Set(selectedAllMcpServerIds);
    const selectedUserMcpServerIds = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const selectedAllSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id))
      .map((server) => toSessionMcpServer(server));
    const selectedSessionMcpServers = availableMcpServers
      .filter((server) => selectedMcpServerIdSet.has(server.id) && server.builtin === true)
      .map((server) => toSessionMcpServer(server));
    const defaultSelectedMcpServerIds = assistantDefaultMcpIds;
    const defaultSelectedUserMcpServerIds = availableMcpServers
      .filter((server) => (defaultSelectedMcpServerIds ?? []).includes(server.id) && server.builtin !== true)
      .map((server) => server.id);
    const assistantOverrideMcpIds =
      selectedMcpServerIds !== undefined ? selectedAllMcpServerIds : defaultSelectedMcpServerIds;
    const selectedUserMcpServerIdsToSend =
      selectedMcpServerIds !== undefined ? selectedUserMcpServerIds : defaultSelectedUserMcpServerIds;
    let selectedSessionMcpServersToSend =
      selectedMcpServerIds !== undefined
        ? selectedAllSessionMcpServers
        : availableMcpServers
            .filter((server) => (defaultSelectedMcpServerIds ?? []).includes(server.id))
            .map((server) => toSessionMcpServer(server));

    const creationRequest: CreationRequest | undefined = creationIntent
      ? {
          id: creationIntent.profileId ?? creationIntent.family,
          name: comfyFamilyDetails(creationIntent.family).name,
          kind: comfyFamilyDetails(creationIntent.family).kind,
          source: 'local',
          state: creationIntent.profileId ? 'invalid' : 'not-installed',
          family: creationIntent.family,
          intent: creationIntent.intent,
          profileId: creationIntent.profileId,
        }
      : creationModel
        ? {
            id: creationModel.id,
            name: creationModel.name,
            kind: creationModel.kind,
            source: creationModel.source,
            state: creationModel.state,
            family: creationModel.family,
            profileId: creationModel.profileId,
            intent: creationModel.intent ?? 'generate',
          }
        : undefined;
    if (creationRequest?.source === 'cloud') {
      if (creationRequest.kind === 'video') {
        Message.error(t('guid.creation.cloudVideoUnsupported'));
        return false;
      }
      if (!creationModel?.available || !creationModel.provider?.api_key?.trim()) {
        Message.error(t('guid.creation.configureCloud'));
        return false;
      }
    }
    const initialInput =
      creationRequest && input.trim()
        ? creationMessage(
            input,
            t(creationIntent ? 'guid.comfy.intentSummary' : 'guid.creation.requestSummary', {
              kind: t(`guid.templateFilters.${creationRequest.kind}`),
              source: t(`guid.creation.${creationRequest.source}`),
              model:
                creationRequest.name ||
                t(`guid.creation.${creationRequest.source}${creationRequest.kind === 'image' ? 'Image' : 'Video'}`),
              state: t(`guid.creation.states.${creationRequest.state}`),
              intent: creationRequest.intent && t(`guid.comfy.actions.${creationRequest.intent}`),
              profile: creationRequest.profileId ?? '',
            }) +
              (!creationIntent && creationRequest.profileId
                ? `\n${t('guid.comfy.profileSummary', { profile: creationRequest.profileId })}`
                : '')
          )
        : input;
    const creationRequestId = creationRequest ? crypto.randomUUID() : undefined;
    const requiresCreationBinding = creationRequest?.source === 'local';
    const creationSnapshot = creationRequest
      ? { ...creationRequest, requestId: creationRequestId!, templateSnapshot: getGuidTemplateSnapshot() }
      : undefined;
    if (creationRequest) {
      const wantsVideoMedia = requiresCreationBinding || creationRequest.kind === 'video';
      const matchesRequired = (server: IMcpServer) =>
        server.builtin &&
        (wantsVideoMedia ? isBuiltinVideoMediaName(server.name) : isBuiltinImageGenerationName(server.name));
      let required: IMcpServer | undefined;
      try {
        required = requiresCreationBinding
          ? (await ensureBackendMcpCatalog()).allServers.find(matchesRequired)
          : availableMcpServers.find(matchesRequired);
        // First-load migrations can register builtin tools after Guid mounts.
        if (!required && !requiresCreationBinding)
          required = (await ensureBackendMcpCatalog()).allServers.find(matchesRequired);
      } catch {
        Message.error(t('guid.creation.toolsCheckFailed', { reason: 'COMFY_MCP_CATALOG_UNAVAILABLE' }));
        return false;
      }
      if (!required) {
        Message.error(t('guid.creation.toolsUnavailable'));
        return false;
      }
      const sessionServers =
        selectedMcpServerIds !== undefined ? selectedSessionMcpServers : selectedSessionMcpServersToSend;
      // Replace the cached required transport, including legacy-name aliases.
      // A matching id in Guid's mounted state is not evidence of a current script.
      const combined = [
        ...sessionServers.filter(
          (server) =>
            server.id !== required.id &&
            !(wantsVideoMedia ? isBuiltinVideoMediaName(server.name) : isBuiltinImageGenerationName(server.name))
        ),
        toSessionMcpServer(required),
      ];
      selectedSessionMcpServersToSend = creationSessionServers(
        combined,
        creationRequest,
        creationRequest.source === 'cloud' ? creationModel?.provider : undefined,
        creationRequestId
      );
      if (requiresCreationBinding) {
        const scoped = selectedSessionMcpServersToSend.find((server) => server.id === required.id)!;
        try {
          const check = await ipcBridge.mcpService.testMcpConnection.invoke({
            ...required,
            name: scoped.name,
            transport: scoped.transport,
            runtime_scope_id: creationRequestId,
          });
          const tools = new Set(check.tools?.map((tool) => tool.name));
          const needed = [
            'openh3_comfy_environment',
            'openh3_comfy_profiles',
            ...(creationRequest.intent === 'generate'
              ? ['openh3_comfy_generate', 'openh3_comfy_job_status', 'openh3_comfy_cancel_job']
              : ['openh3_comfy_install']),
          ];
          const missing = needed.filter((name) => !tools.has(name));
          if (!check.success || missing.length) {
            const reason = !check.success
              ? (check.code ?? 'COMFY_MCP_CONNECTION_FAILED')
              : `COMFY_REQUIRED_TOOLS_MISSING: ${missing.join(', ')}`;
            Message.error(t('guid.creation.toolsCheckFailed', { reason }));
            return false;
          }
        } catch (cause) {
          const reason = isBackendHttpError(cause) && cause.code ? cause.code : 'COMFY_MCP_CONNECTION_FAILED';
          Message.error(t('guid.creation.toolsCheckFailed', { reason }));
          return false;
        }
      }
    }

    // `current_model` is the aionrs provider selection and means nothing to a
    // CLI agent, which owns its own model list. Used as a blanket fallback it
    // leaked into the FIRST turn of every CLI conversation: before the agent's
    // catalog has been probed the two preceding options are empty, so a brand
    // new Antigravity conversation started with e.g. `gemini-3.1-pro-preview`
    // — a provider model agy has never heard of — and the turn failed with
    // USER_LLM_PROVIDER_MODEL_NOT_FOUND. Once the catalog lands the second
    // option wins, which is why it only ever reproduced on first use.
    //
    // Omitting it lets the agent start on its own default, which is what a user
    // who has not picked a model means. The cron dialog already gates the same
    // value this way (`resolvedBackend !== 'aionrs' → undefined`).
    //
    // The cached `current_model_id` is NOT a fallback for the same reason, and it
    // used to defeat the very intent described above. It is whatever the LAST
    // session of this agent wrote back, so an unpicked conversation inherited a
    // stranger's choice: for claude that was usually its `default` row, which
    // PINS the account default and overrides the user's own ANTHROPIC_MODEL — so
    // the app ran a different model than `claude` in a terminal did, and the
    // picker contradicted itself (the row promised one model, the session used
    // another). Omit it: no pick means no override, and the agent resolves the
    // model from the user's own config.
    const assistantOverrideModel =
      selectedAcpModel || (assistantBackend === 'aionrs' ? current_model?.use_model : undefined) || undefined;
    const assistantOverrides = {
      model: assistantOverrideModel,
      permission: selectedMode || undefined,
      thought_level: selectedThoughtLevelValue || undefined,
      skill_ids: requiresCreationBinding
        ? [...new Set([...(enabled_skills_to_send ?? []), 'comfyui-local'])]
        : enabled_skills_to_send,
      disabled_builtin_skill_ids: requiresCreationBinding
        ? (excludeBuiltinSkills ?? []).filter((skill) => skill !== 'comfyui-local')
        : excludeBuiltinSkills,
      mcp_ids: creationRequest
        ? [
            ...new Set([
              ...(assistantOverrideMcpIds ?? []),
              ...selectedSessionMcpServersToSend.map((server) => server.id),
            ]),
          ]
        : assistantOverrideMcpIds,
    };

    if (guidDraftScope !== getGuidDraftScope()) return false;
    if (assistantBackend === 'aionrs') {
      if (!current_model) {
        Message.warning(t('conversation.noModelConfigured'));
        return false;
      }
      try {
        const conversation = await ipcBridge.conversation.create.invoke({
          name: input,
          model: current_model,
          assistant: {
            id: assistantConversationId,
            locale: localeKey,
            conversation_overrides: assistantOverrides,
          },
          extra: {
            ...(creationSnapshot ? { creation_request: creationSnapshot } : {}),
            default_files: files.map(chatFileRefPath),
            workspace: finalWorkspace,
            custom_workspace: isCustomWorkspace,
            selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
            selected_session_mcp_servers: selectedSessionMcpServersToSend,
          },
        });

        if (!conversation || !conversation.id) {
          Message.error(t('conversation.createFailed'));
          return false;
        }

        if (isCustomWorkspace) {
          updateWorkspaceTime(finalWorkspace);
        }

        if (assistantConversationId) {
          await Promise.all([
            swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
            swrMutate('assistants.list'),
          ]);
        }

        if (guidDraftScope !== getGuidDraftScope()) return false;
        emitter.emit('chat.history.refresh');

        // Empty input = "start chat": create the conversation but do not stash an
        // initial message, so the window opens idle on the empty state instead of
        // auto-sending a blank first turn.
        if (input.trim() || creationRequestId) {
          const initialMessage = {
            input: initialInput,
            files: files.length > 0 ? files : undefined,
            guidDraft: input,
            guidDraftScope,
            creationRequestId,
            creationRequest: creationSnapshot,
          };
          sessionStorage.setItem(`aionrs_initial_message_${conversation.id}`, JSON.stringify(initialMessage));
        }

        writeComfyDraftIntent(undefined);
        await navigate(`/conversation/${conversation.id}`);
        return true;
      } catch (error: unknown) {
        console.error('Failed to create OpenH3 Core conversation:', error);
        throw error;
      }
    }

    try {
      const conversation = await ipcBridge.conversation.create.invoke({
        name: input,
        assistant: {
          id: assistantConversationId,
          locale: localeKey,
          conversation_overrides: assistantOverrides,
        },
        extra: {
          ...(creationSnapshot ? { creation_request: creationSnapshot } : {}),
          workspace: finalWorkspace,
          custom_workspace: isCustomWorkspace,
          default_files: files.map(chatFileRefPath),
          selected_mcp_server_ids: selectedUserMcpServerIdsToSend,
          selected_session_mcp_servers: creationRequest
            ? selectedSessionMcpServersToSend
            : selectedMcpServerIds !== undefined
              ? selectedSessionMcpServers
              : selectedSessionMcpServersToSend,
        },
      });
      if (!conversation || !conversation.id) {
        console.error('Failed to create ACP conversation - conversation object is null or missing id');
        Message.error(t('conversation.createFailed'));
        return false;
      }

      if (isCustomWorkspace) {
        updateWorkspaceTime(finalWorkspace);
      }

      if (assistantConversationId) {
        await Promise.all([
          swrMutate(`guid.assistant.detail.${assistantConversationId}.${localeKey}`),
          swrMutate('assistants.list'),
        ]);
      }

      if (guidDraftScope !== getGuidDraftScope()) return false;
      emitter.emit('chat.history.refresh');

      // Empty input = "start chat": create the conversation but do not stash an
      // initial message, so the window opens idle on the empty state instead of
      // auto-sending a blank first turn.
      if (input.trim() || creationRequestId) {
        const initialMessage = {
          input: initialInput,
          files: files.length > 0 ? files : undefined,
          guidDraft: input,
          guidDraftScope,
          creationRequestId,
          creationRequest: creationSnapshot,
        };
        sessionStorage.setItem(`acp_initial_message_${conversation.id}`, JSON.stringify(initialMessage));
      }

      writeComfyDraftIntent(undefined);
      await navigate(`/conversation/${conversation.id}`);
      return true;
    } catch (error: unknown) {
      console.error('Failed to create ACP conversation:', error);
      throw error;
    }
  }, [
    creationModel,
    creationIntent,
    input,
    files,
    dir,
    selectedAssistantId,
    selectedAssistantBackend,
    selectedMode,
    selectedAcpModel,
    selectedThoughtLevelValue,
    current_model,
    guidDisabledBuiltinSkills,
    guidEnabledSkills,
    assistantDefaultSkillIds,
    assistantDefaultDisabledBuiltinSkillIds,
    availableMcpServers,
    selectedMcpServerIds,
    assistantDefaultMcpIds,
    navigate,
    t,
    localeKey,
  ]);

  const sendMessageHandler = useCallback(() => {
    if (loading || sendingRef.current) return;
    sendingRef.current = true;
    setLoading(true);
    handleSend()
      .then((created) => {
        if (!created) return;
        setMentionOpen(false);
        setMentionQuery(null);
        setMentionSelectorOpen(false);
        setMentionActiveIndex(0);
        setFiles([]);
        setDir('');
      })
      .catch((error) => {
        console.error('Failed to send message:', error);
        Message.error(getConversationCreateErrorMessage(error, t));
      })
      .finally(() => {
        sendingRef.current = false;
        setLoading(false);
      });
  }, [
    loading,
    handleSend,
    setLoading,
    setMentionOpen,
    setMentionQuery,
    setMentionSelectorOpen,
    setMentionActiveIndex,
    setFiles,
    setDir,
    t,
  ]);

  // Calculate button disabled state
  // Calculate button disabled state. Empty input is allowed once an assistant is
  // picked — that path creates an empty conversation ("start chat") rather than
  // sending a message, so the gate only blocks while loading or with no assistant.
  const isButtonDisabled = loading || !selectedAssistantId;

  return {
    handleSend,
    sendMessageHandler,
    isButtonDisabled,
  };
};
