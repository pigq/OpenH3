import { describe, it, expect } from 'vitest';
import { catalogPageState } from '@/renderer/components/ContentCatalog/contentCatalogState';
import { candidate } from './fixtures';
describe('page content snapshot', () => {
  it('does not rearrange an open page before explicit acceptance', () => {
    const current = candidate(1).catalog,
      latest = candidate(2).catalog;
    const state = catalogPageState({ current }, latest);
    expect(state.current).toBe(current);
    expect(state.pending).toBe(latest);
    expect(catalogPageState(state, latest, true)).toEqual({ current: latest });
  });
  it('accepts explicit local restore even when its sequence is lower', () => {
    const older = candidate(1).catalog;
    expect(catalogPageState({ current: candidate(2).catalog }, older).pending).toBe(older);
  });
});
