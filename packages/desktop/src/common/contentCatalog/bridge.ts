import { httpGet, httpPost, getBaseUrl } from '../adapter/httpBridge';
import type { ContentCatalog, ContentStatus } from './schema';
const prefix = '/api/content-catalog';
export const contentCatalog = {
  catalog: httpGet<ContentCatalog>(`${prefix}/catalog`),
  status: httpGet<ContentStatus>(`${prefix}/status`),
  check: httpPost<ContentStatus, Record<string, never>>(`${prefix}/check`),
  cancel: httpPost<ContentStatus, Record<string, never>>(`${prefix}/cancel`),
  restore: httpPost<ContentStatus, Record<string, never>>(`${prefix}/restore`),
  settings: httpPost<ContentStatus, { autoSync: boolean }>(`${prefix}/settings`),
  lease: httpPost<ContentStatus, { sequence: number }>(`${prefix}/lease`),
};
export const contentAssetUrl = (sequence: number, hash: string): string =>
  `${getBaseUrl()}${prefix}/assets/${sequence}/${hash}`;
