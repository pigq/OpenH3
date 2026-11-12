import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ComfyDraftIntent } from './comfyDraft';
import type { ModelCenterEntry } from './modelCenterEntry';

type Options = {
  entry?: ModelCenterEntry;
  intent?: ComfyDraftIntent;
  input: string;
  prompt: string;
  ready: boolean;
  setIntent: (intent?: ComfyDraftIntent) => void;
  setInput: (input: string) => void;
  resetAttachments: () => void;
  selectProfile: (profileId: string, kind: 'image' | 'video') => void;
  consume: () => void;
  send: () => void;
};

/** Consume explicit center actions once; back navigation must never resubmit an installation. */
export function useModelCenterEntry(options: Options) {
  const prepared = useRef<string | undefined>(undefined);
  const submitted = useRef<string | undefined>(undefined);
  const { entry, intent, input, prompt, ready, setIntent, setInput, resetAttachments, selectProfile, consume, send } =
    options;
  useLayoutEffect(() => {
    if (!entry || prepared.current === entry.token) return;
    prepared.current = entry.token;
    setIntent(entry.action === 'install' ? entry.intent : undefined);
    if (entry.action === 'use') {
      selectProfile(entry.profileId, entry.kind);
      consume();
    } else {
      resetAttachments();
      setInput(prompt);
    }
  }, [entry, prompt, setIntent, setInput, resetAttachments, selectProfile, consume]);
  useEffect(() => {
    if (!entry || entry.action !== 'install' || !ready || submitted.current === entry.token) return;
    if (intent?.requestId !== entry.intent.requestId || input !== prompt) return;
    submitted.current = entry.token;
    consume();
    send();
  }, [entry, intent, input, prompt, ready, consume, send]);
}
