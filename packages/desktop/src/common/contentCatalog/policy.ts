import semver from 'semver';
import type { OfficialEntry, OfficialTemplate } from './schema';
export type ClientCapabilities = { version: string; capabilities: readonly string[] };
export const CONTENT_CAPABILITIES = [
  'template.image',
  'template.video',
  'comfy.h3',
  'comfy.qwen-edit',
  'comfy.z-image',
] as const;
export const localize = (values: Record<string, string>, locale: string, defaultLocale: string): string =>
  values[locale] ?? values[locale.split('-')[0]] ?? values[defaultLocale] ?? '';
export const supportsEntry = (
  entry: { minClientVersion: string; requiredCapabilities: readonly string[] },
  client: ClientCapabilities
): boolean =>
  Boolean(
    semver.valid(client.version) &&
    semver.valid(entry.minClientVersion) &&
    semver.gte(client.version, entry.minClientVersion) &&
    entry.requiredCapabilities.every((c) => client.capabilities.includes(c))
  );
export function resolveEntryAction(
  entry: OfficialEntry,
  entries: readonly OfficialEntry[],
  client: ClientCapabilities
): { primary: 'use-template' | 'view-showcase' | 'requires-client-update'; template?: OfficialTemplate } {
  if (entry.entryType === 'template')
    return supportsEntry(entry, client)
      ? { primary: 'use-template', template: entry }
      : { primary: 'requires-client-update' };
  const linked =
    entry.templateRef &&
    entries.find((t) => t.id === entry.templateRef!.id && t.revision === entry.templateRef!.revision);
  return {
    primary: 'view-showcase',
    ...(supportsEntry(entry, client) && linked?.entryType === 'template' && supportsEntry(linked, client)
      ? { template: linked }
      : {}),
  };
}
