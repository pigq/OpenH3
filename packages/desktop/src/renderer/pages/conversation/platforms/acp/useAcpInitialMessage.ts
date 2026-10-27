/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TMessage } from '@/common/chat/chatLib';
import type { TConversationRuntimeSummary } from '@/common/config/storage';
import { parseError, uuid } from '@/common/utils';
import { emitter } from '@/renderer/utils/emitter';
import { type ChatFileRef, isChatFileRef, uploadFileRef } from '@/common/types/chatFile';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { getConversationRuntimeWorkspaceErrorMessage } from '../../utils/conversationCreateError';
import type { ConversationRuntimeSendFailure } from '../../runtime/conversationRuntimeViewStore';
import { classifyConversationBusyError } from '../conversationBusyError';
import { buildSendFailureError } from './buildSendFailureError';
import { h3JobApi } from '@/common/chat/document/h3JobApi';
import { comfyApi } from '@/common/chat/document/creation/comfyApi';
import type { ComfyFamily, ComfyIntent } from '@/common/chat/document/creation/comfy';
import {
  clearGuidDraftIfMatches,
  getGuidDraftScope,
  isGuidDraftScopeCurrent,
} from '@/renderer/pages/guid/hooks/useGuidDraft';
import { beginComfySelectionChange } from '../../runtime/Creation/useComfySelectionPending';

type UseAcpInitialMessageParams = {
  conversation_id: string;
  backend: string;
  setAiProcessing: (value: boolean) => void;
  resetState: () => void;
  markSendStarted?: () => void;
  markSendAccepted?: (turn_id: string, runtime: TConversationRuntimeSummary, msg_id?: string) => void;
  markSendFailed?: (failure: ConversationRuntimeSendFailure) => void;
  checkAndUpdateTitle: (conversation_id: string, input: string) => void;
  addOrUpdateMessage: (message: TMessage, prepend?: boolean) => void;
};

/**
 * Side-effect-only hook that checks sessionStorage for an initial message
 * and sends it when the ACP conversation first mounts.
 */
export const useAcpInitialMessage = ({
  conversation_id,
  backend,
  setAiProcessing,
  resetState,
  markSendStarted,
  markSendAccepted,
  markSendFailed,
  checkAndUpdateTitle,
  addOrUpdateMessage,
}: UseAcpInitialMessageParams): void => {
  const { t } = useTranslation();
  const attemptedConversation = useRef<string | undefined>(undefined);

  useEffect(() => {
    const storageKey = `acp_initial_message_${conversation_id}`;
    const storedMessage = sessionStorage.getItem(storageKey);

    if (!storedMessage || attemptedConversation.current === conversation_id) return;
    attemptedConversation.current = conversation_id;

    // Clear immediately to prevent duplicate sends (e.g., if component remounts while sendMessage is pending)
    sessionStorage.removeItem(storageKey);

    let bindingPending = false;
    let finishBinding: (() => void) | undefined;
    const sendInitialMessage = async () => {
      try {
        const initialMessage = JSON.parse(storedMessage);
        const guidDraftScope = getGuidDraftScope();
        if (!isGuidDraftScopeCurrent(initialMessage.guidDraftScope)) return;
        const input = typeof initialMessage.input === 'string' ? initialMessage.input : '';
        // Guid-page initial files are source-tagged ChatFileRefs (`local` for
        // backend-machine picks, `upload` for device uploads). Body stays plain
        // text; the backend resolves each ref and injects the [[AION_FILES]]
        // marker at the send edge. Legacy string[] entries (a stale pre-upgrade
        // session) coerce to upload refs for back-compat.
        const files: ChatFileRef[] = Array.isArray(initialMessage.files)
          ? initialMessage.files
              .map((f: unknown) => (typeof f === 'string' ? uploadFileRef(f) : f))
              .filter(isChatFileRef)
          : [];

        if (typeof initialMessage.creationRequestId === 'string' && initialMessage.creationRequest) {
          bindingPending = true;
          finishBinding = beginComfySelectionChange(conversation_id);
          const request = initialMessage.creationRequest as {
            profileId?: string;
            family?: ComfyFamily;
            intent?: ComfyIntent;
            source?: 'local' | 'cloud';
            kind?: 'image' | 'video';
            templateSnapshot?: import('@/common/contentCatalog/snapshot').TemplateSnapshot;
          };
          const bound = await comfyApi.bind(
            initialMessage.creationRequestId,
            conversation_id,
            request.profileId,
            request.family,
            request.intent,
            {
              source: request.source ?? 'local',
              kind: request.kind ?? 'image',
              templateSnapshot: request.templateSnapshot,
            }
          );
          if (!bound.ok) throw new Error(t('guid.creation.toolsUnavailable'));
          bindingPending = false;
        } else if (typeof initialMessage.creationRequestId === 'string') {
          bindingPending = true;
          finishBinding = beginComfySelectionChange(conversation_id);
          await h3JobApi.bindCreation(initialMessage.creationRequestId, conversation_id);
          bindingPending = false;
        }
        // An empty creation entry only binds its tools; the chat opens idle.
        if (!input.trim() || guidDraftScope !== getGuidDraftScope()) return;

        markSendStarted?.();
        setAiProcessing(true);

        void checkAndUpdateTitle(conversation_id, input);
        const result = await ipcBridge.acpConversation.sendMessage.invoke({
          input,
          conversation_id: conversation_id,
          files,
        });
        markSendAccepted?.(result.turn_id, result.runtime, result.msg_id);
        if (typeof initialMessage.guidDraft === 'string')
          clearGuidDraftIfMatches(initialMessage.guidDraft, guidDraftScope);

        // Initial message sent successfully
        emitter.emit('chat.history.refresh');
      } catch (error) {
        // No message was sent if binding failed. Reopening the chat can retry safely.
        if (bindingPending) sessionStorage.setItem(storageKey, storedMessage);
        const errorMessageText =
          getConversationRuntimeWorkspaceErrorMessage(error, t) || parseError(error) || t('common.unknownError');
        const busyError = classifyConversationBusyError(error);
        if (busyError) {
          markSendFailed?.({
            kind: 'busy_conflict',
            reason: errorMessageText,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          console.info('[useAcpInitialMessage] Initial send hit conversation busy state:', {
            conversation_id,
            busyKind: busyError.kind,
            status: busyError.status,
            code: busyError.code,
          });
          return;
        }

        markSendFailed?.({ kind: 'ordinary', reason: errorMessageText });
        console.error('[useAcpInitialMessage] Error sending initial message:', error);
        console.error('[useAcpInitialMessage] Error details:', {
          name: (error as Error)?.name,
          message: errorMessageText,
          conversation_id,
        });

        const errorMessage: TMessage = {
          id: uuid(),
          msg_id: uuid(),
          conversation_id: conversation_id,
          type: 'tips',
          position: 'center',
          content: {
            content: errorMessageText,
            type: 'error',
            error: buildSendFailureError(error, errorMessageText),
          },
          created_at: Date.now() + 2,
        };
        addOrUpdateMessage(errorMessage, true);
        resetState();
        setAiProcessing(false); // Keep the prop-setter in sync with the hook reset
      } finally {
        finishBinding?.();
      }
    };

    sendInitialMessage().catch((error) => {
      console.error('Failed to send initial message:', error);
    });
  }, [
    addOrUpdateMessage,
    backend,
    checkAndUpdateTitle,
    conversation_id,
    markSendAccepted,
    markSendFailed,
    markSendStarted,
    resetState,
    setAiProcessing,
    t,
  ]);
};
