import { useCallback, useEffect, useRef, useState } from 'react';

const ROUND_KEY = 'openh3.creative-prompt-round';
const PROMPT_SETS = [
  ['image', 'reference', 'story', 'models'],
  ['product', 'portrait', 'travel', 'repair'],
  ['poster', 'restyle', 'storyboard', 'edit'],
] as const;

/** Rotate on a new conversation or explicit refresh, never while the user types. */
export function useCreativePrompts(newConversationKey?: string) {
  const [round, setRound] = useState(() => Number(localStorage.getItem(ROUND_KEY) ?? '0'));
  const lastNavigation = useRef(newConversationKey);
  const refresh = useCallback(() => setRound((previous) => (previous + 1) % PROMPT_SETS.length), []);
  useEffect(() => {
    localStorage.setItem(ROUND_KEY, String((round + 1) % PROMPT_SETS.length));
  }, [round]);
  useEffect(() => {
    if (newConversationKey && newConversationKey !== lastNavigation.current) refresh();
    lastNavigation.current = newConversationKey;
  }, [newConversationKey, refresh]);
  return { keys: PROMPT_SETS[round], refresh };
}
