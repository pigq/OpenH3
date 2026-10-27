import type { ContentCatalog } from '@/common/contentCatalog/schema';
export type CatalogPageState = { current?: ContentCatalog; pending?: ContentCatalog };
/** Polling never changes a page the user is browsing. */
export function catalogPageState(state: CatalogPageState, latest: ContentCatalog, accept = false): CatalogPageState {
  if (!state.current || accept) return { current: latest };
  if (state.current.releaseSequence === latest.releaseSequence) return { current: state.current };
  return { ...state, pending: latest };
}
