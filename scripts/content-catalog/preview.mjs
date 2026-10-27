import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { contentDiff } from './build.mjs';
import { bundleModule } from './helpers.mjs';
const { values } = parseArgs({ options: { before: { type: 'string' }, after: { type: 'string' } } });
const { parseCatalog } = await bundleModule('packages/desktop/src/common/contentCatalog/schema.ts');
console.log(
  JSON.stringify(
    contentDiff(
      values.before ? parseCatalog(JSON.parse(await fs.readFile(values.before, 'utf8'))) : undefined,
      parseCatalog(JSON.parse(await fs.readFile(values.after, 'utf8')))
    ),
    null,
    2
  )
);
