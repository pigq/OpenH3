import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ComfyGenerationInput, ComfyProfile, ComfyReference } from '@/common/chat/document/creation/comfy';
import type {
  GenerationAttemptIdentity,
  GenerationAttemptRequest,
  GenerationExecutionSnapshot,
} from '@/common/chat/document/creation/workflows/contracts';
import { getComfyModelSetId } from '@/common/chat/document/creation/workflows/identity';

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function references(input: ComfyGenerationInput): ComfyReference[] {
  return input.references ?? input.imagePaths?.map((file) => ({ type: 'image', path: file })) ?? [];
}

function inputFingerprint(input: ComfyGenerationInput): string {
  // Fast reservation uses source file identity; the execution snapshot records streamed byte digests.
  const files = references(input).map((reference) => {
    const stat = fs.statSync(reference.path);
    return { size: stat.size, modifiedAt: stat.mtimeMs };
  });
  return hash(canonical({ input, files }));
}

/** Reserve the workflow and semantic input identity before scheduling an explicit generation attempt. */
export function buildAttemptIdentity(
  profile: ComfyProfile,
  input: ComfyGenerationInput,
  request: GenerationAttemptRequest,
  selectionRevision: number
): GenerationAttemptIdentity {
  const workflowHash = hash(fs.readFileSync(profile.workflowPath));
  if (profile.workflowSha256 && profile.workflowSha256.toLowerCase() !== workflowHash)
    throw new Error('COMFY_WORKFLOW_HASH_MISMATCH');
  return {
    ...request,
    modelSetId: getComfyModelSetId(profile),
    selectionRevision,
    workflowId: profile.workflowMetadata?.id ?? profile.id,
    workflowRevision: profile.workflowMetadata?.revision ?? profile.version,
    workflowHash,
    inputFingerprint: inputFingerprint(input),
  };
}

async function copyReference(source: string, destination: string, signal: AbortSignal): Promise<string> {
  const digest = crypto.createHash('sha256');
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(fs.createReadStream(source), hashing, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
  return digest.digest('hex');
}

/** Freeze graph and ordered references before execution without buffering large reference media. */
export async function captureGenerationSnapshot(
  profile: ComfyProfile,
  input: ComfyGenerationInput,
  identity: GenerationAttemptIdentity,
  root: string,
  environmentFingerprint: string,
  signal: AbortSignal
): Promise<{ input: ComfyGenerationInput; snapshot: GenerationExecutionSnapshot; workflowPath: string }> {
  signal.throwIfAborted();
  const workflow = await fs.promises.readFile(profile.workflowPath, { signal });
  if (hash(workflow) !== identity.workflowHash) throw new Error('COMFY_ATTEMPT_WORKFLOW_CHANGED');
  if (inputFingerprint(input) !== identity.inputFingerprint) throw new Error('COMFY_ATTEMPT_INPUT_CHANGED');
  const directory = path.join(root, hash(identity.taskId), hash(identity.attemptId));
  await fs.promises.mkdir(directory, { recursive: true });
  const workflowPath = path.join(directory, 'workflow.json');
  await fs.promises.writeFile(workflowPath, workflow, { flag: 'wx', signal });
  const savedReferences: GenerationExecutionSnapshot['references'] = [];
  for (const [index, reference] of references(input).entries()) {
    const destination = path.join(directory, `${index + 1}${path.extname(reference.path)}`);
    const sha256 = await copyReference(reference.path, destination, signal);
    savedReferences.push({
      ...reference,
      type: reference.type!,
      id: reference.id ?? `reference-${index + 1}`,
      path: destination,
      sha256,
    });
  }
  if (inputFingerprint(input) !== identity.inputFingerprint) throw new Error('COMFY_ATTEMPT_INPUT_CHANGED');
  if (hash(await fs.promises.readFile(profile.workflowPath, { signal })) !== identity.workflowHash)
    throw new Error('COMFY_ATTEMPT_WORKFLOW_CHANGED');
  const capturedInput: ComfyGenerationInput = structuredClone(input);
  if (capturedInput.references)
    capturedInput.references = capturedInput.references.map((reference, index) => ({
      ...reference,
      id: savedReferences[index].id,
      path: savedReferences[index].path,
    }));
  else if (capturedInput.imagePaths) capturedInput.imagePaths = savedReferences.map((reference) => reference.path);
  const parameters: GenerationExecutionSnapshot['parameters'] = { ...profile.defaults };
  for (const [key, value] of Object.entries(input))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') parameters[key] = value;
  return {
    input: capturedInput,
    workflowPath,
    snapshot: {
      identity: { ...identity },
      profileId: profile.id,
      environmentFingerprint,
      dependencies: profile.components.map(({ role, path: file, sha256, version, precision }) => ({
        role,
        path: file,
        sha256,
        version,
        precision,
      })),
      parameters,
      references: savedReferences,
    },
  };
}
