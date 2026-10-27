import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  comfyInstallPlanSchema,
  comfyFamilyKind,
  type ComfyInstallIdentityRequest,
  type ComfyInstallPlan,
  type ComfyProfile,
} from '@/common/chat/document/creation/comfy';
import {
  discoverComfyEnvironmentCandidates,
  probeComfyEnvironment,
  type ComfyEnvironmentReport,
} from '../discovery/environment';
import {
  loadComfyInstallCatalog,
  record,
  records,
  stringValue,
  type CatalogRecord,
  type ComfyInstallCatalog,
} from './catalog';
import {
  assertPlanningHardware,
  probePlanningKernels,
  selectComfyCandidate,
  type ComfyKernelEvidence,
} from './hardwareSelection';
import { findBootstrapPython, prepareComfyRuntime, type RuntimePreparationOptions } from './runtimePreparation';
import { selectComfyTransports } from './transportSelection';
import { ensureComfySmokeReference } from './smokeReference';
import { createLegacyH3InstallPlan, H3_PORTABLE_INSTALL_EVIDENCE } from './legacyInstallPlan';

export type ComfyInstallPlannerOptions = RuntimePreparationOptions & {
  dataDir: string;
  resourcesRoot?: string;
  roots?: () => string[];
  h3BundleRoot?: () => string;
  probe?: typeof probeComfyEnvironment;
  loadCatalog?: () => ComfyInstallCatalog;
  probeKernels?: (python: string) => Promise<ComfyKernelEvidence>;
  prepareRuntime?: typeof prepareComfyRuntime;
  selectTransports?: typeof selectComfyTransports;
};

function serialization(graph: unknown): string {
  return `${JSON.stringify(graph, null, 2)}\n`;
}
function graphHash(graph: unknown): string {
  return crypto.createHash('sha256').update(serialization(graph)).digest('hex');
}
function withinDirectory(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
/** Recognize only the layout this planner creates; an arbitrary sibling Python is not a writable runtime root. */
function managedRuntimeRoot(
  options: ComfyInstallPlannerOptions,
  profile: ComfyProfile,
  coreRevision?: string
): string | undefined {
  if (!coreRevision || !/^[a-f\d]{40}$/i.test(coreRevision)) return undefined;
  const root = path.resolve(options.dataDir, 'comfy-runtimes', coreRevision.slice(0, 12));
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (
    path.relative(path.join(root, 'ComfyUI'), profile.environment.root) !== '' ||
    path.relative(python, profile.environment.python) !== '' ||
    !withinDirectory(path.join(root, 'openh3-workflows'), profile.workflowPath)
  )
    return undefined;
  const actualDataRoot = fs.realpathSync(options.dataDir);
  for (const file of [root, profile.environment.root, profile.environment.python, profile.workflowPath]) {
    let ancestor = file;
    while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (!withinDirectory(actualDataRoot, fs.realpathSync(ancestor)))
      throw new Error('COMFY_PATH_REALPATH_OUTSIDE_ROOT');
  }
  return root;
}
function baselineFor(catalog: ComfyInstallCatalog, candidate: CatalogRecord): CatalogRecord {
  const graph = catalog.baselines.find((entry) => entry.id === candidate.apiBaselineId);
  if (!graph || !Object.keys(record(graph.graph)).length || graph.graphSha256 !== graphHash(graph.graph))
    throw new Error(`COMFY_TOOL_NOT_READY:FIXED_API_WORKFLOW:${stringValue(candidate.id)}`);
  return graph;
}
function candidateForProfile(catalog: ComfyInstallCatalog, profile: ComfyProfile): CatalogRecord | undefined {
  return catalog.candidates.find(
    (candidate) =>
      candidate.family === profile.family &&
      records(candidate.components).every((item) =>
        profile.components.some(
          (component) => component.sha256 === item.sha256 && component.sizeBytes === item.sizeBytes
        )
      )
  );
}
function smokeInput(
  baseline: CatalogRecord,
  bindings: ComfyProfile['bindings'],
  options: ComfyInstallPlannerOptions
): ComfyInstallPlan['smokeInput'] {
  const input = { ...record(baseline.smokeInput) };
  if (!input.prompt) input.prompt = 'A red ceramic cup on a wooden table, soft daylight.';
  if (bindings.image?.length || baseline.family === 'fasth3-omni')
    input.references = [
      { type: 'image', path: ensureComfySmokeReference(path.join(options.dataDir, 'comfy-planning')) },
    ];
  return input as ComfyInstallPlan['smokeInput'];
}
async function modelComponents(
  candidate: CatalogRecord,
  root: string,
  options: ComfyInstallPlannerOptions
): Promise<ComfyProfile['components']> {
  return Promise.all(
    records(candidate.components).map(async (item) => {
      const directory = stringValue(item.directory),
        name = stringValue(item.name);
      if (!directory || path.basename(directory) !== directory || !name || path.basename(name) !== name)
        throw new Error('COMFY_TOOL_NOT_READY:CATALOG_MODEL_PATH');
      const urls = await (options.selectTransports ?? selectComfyTransports)(item, options.fetchImpl);
      return {
        role: stringValue(item.role),
        name,
        path: path.join(root, 'models', directory, name),
        version: stringValue(item.revision),
        precision: stringValue(item.precision),
        url: urls[0],
        sourceUrls: urls,
        sha256: stringValue(item.sha256),
        sizeBytes: Number(item.sizeBytes),
      };
    })
  );
}

/** Identity-only card requests become immutable, host-specific executable plans. */
export function createComfyInstallPlanner(options: ComfyInstallPlannerOptions) {
  return async (
    _requestId: string,
    request: ComfyInstallIdentityRequest,
    profiles: readonly ComfyProfile[] = []
  ): Promise<ComfyInstallPlan> => {
    const catalog = (options.loadCatalog ?? (() => loadComfyInstallCatalog(options.resourcesRoot)))();
    const requestedProfile = request.profileId
      ? profiles.find((profile) => profile.id === request.profileId)
      : undefined;
    if (requestedProfile && requestedProfile.family !== request.family)
      throw new Error('COMFY_INSTALL_PROFILE_FAMILY_MISMATCH');
    const familyProfiles = profiles.filter((profile) => profile.family === request.family);
    const existingProfile =
      request.intent === 'install-other'
        ? undefined
        : (requestedProfile ??
          (request.intent === 'repair'
            ? familyProfiles[0]
            : familyProfiles.find((profile) => profile.state !== 'invalid')));
    if (request.intent === 'repair' && !existingProfile)
      throw new Error('COMFY_DETECTION_INCOMPLETE:REPAIR_PROFILE_NOT_FOUND');
    const roots = [
      ...new Set([
        ...(options.roots?.() ?? []),
        ...profiles.map((profile) => profile.environment.root),
        options.dataDir,
      ]),
    ];
    const discovered = discoverComfyEnvironmentCandidates({ roots });
    const initial = existingProfile?.environment ?? discovered[0] ?? { root: options.dataDir };
    const probe = options.probe ?? probeComfyEnvironment;
    let report = await probe({
      root: initial.root,
      python: initial.python,
      baseUrl: initial.baseUrl,
      runCommand: options.runCommand,
      fetchImpl: options.fetchImpl,
    });
    assertPlanningHardware(report);

    // Registered recipes, including externally discovered/legacy IDs, are
    // repaired in place. Never replace a user's profile with a catalog ID.
    if (existingProfile) {
      const candidate = candidateForProfile(catalog, existingProfile);
      const baseline = candidate?.apiBaselineId ? baselineFor(catalog, candidate) : {};
      let workflow: ComfyInstallPlan['workflow'];
      let workflowSource: string | undefined;
      if (fs.existsSync(existingProfile.workflowPath)) {
        const bytes = fs.readFileSync(existingProfile.workflowPath);
        if (
          existingProfile.workflowSha256 &&
          crypto.createHash('sha256').update(bytes).digest('hex') !== existingProfile.workflowSha256
        )
          throw new Error('COMFY_REPAIR_WORKFLOW_HASH_MISMATCH');
        workflowSource = bytes.toString('utf8');
        workflow = record(JSON.parse(workflowSource)) as ComfyInstallPlan['workflow'];
      } else if (baseline.graph) workflow = record(baseline.graph) as ComfyInstallPlan['workflow'];
      else throw new Error('COMFY_DETECTION_INCOMPLETE:REPAIR_FIXED_WORKFLOW_MISSING');
      const { state: _state, validation: _validation, ...identity } = existingProfile;
      let runtime: Awaited<ReturnType<typeof prepareComfyRuntime>> = { commands: [], components: [], evidence: [] };
      const coreRevision = existingProfile.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version;
      const legacy = existingProfile.family === 'h3' && coreRevision === 'v0.35.0';
      const managedRoot = managedRuntimeRoot(options, existingProfile, coreRevision);
      if (!legacy && request.intent === 'repair') {
        if (!coreRevision) throw new Error('COMFY_DETECTION_INCOMPLETE:REPAIR_RUNTIME_REVISION');
        if (
          !managedRoot &&
          !fs.existsSync(existingProfile.environment.python) &&
          !withinDirectory(
            existingProfile.environment.root,
            path.dirname(path.dirname(existingProfile.environment.python))
          )
        )
          throw new Error('COMFY_DETECTION_INCOMPLETE:EXTERNAL_PROFILE_PYTHON_REPAIR_LOCATION_REQUIRED');
        const bootstrapPython = await findBootstrapPython(options, existingProfile.environment.python);
        runtime = await (options.prepareRuntime ?? prepareComfyRuntime)(
          {
            coreRevision,
            environment: existingProfile.environment,
            targetRoot: managedRoot ?? existingProfile.environment.root,
            report,
            bootstrapPython,
            runtimePins: record(candidate?.runtimePins),
            existing: fs.existsSync(path.join(existingProfile.environment.root, 'main.py')),
          },
          options
        );
      }
      if (!legacy && request.intent !== 'repair' && report.runtime.status !== 'available')
        throw new Error('COMFY_DETECTION_INCOMPLETE:EXISTING_PROFILE_RUNTIME_MISSING_REPAIR_REQUIRED');
      const components = [
        ...identity.components.filter((item) => !runtime.components.some((wheel) => wheel.path === item.path)),
        ...runtime.components,
      ];
      const bytes = components.reduce((sum, component) => {
        try {
          if (
            request.intent !== 'repair' &&
            fs.statSync(component.path).isFile() &&
            fs.statSync(component.path).size === component.sizeBytes
          )
            return sum;
        } catch {
          /* Missing components need a full replacement budget. */
        }
        return sum + (component.sizeBytes ?? 0);
      }, 0);
      const targetRoot =
        legacy && options.h3BundleRoot
          ? options.h3BundleRoot()
          : (managedRoot ?? path.dirname(existingProfile.workflowPath));
      const writableRoots = [targetRoot, identity.environment.root];
      const args = identity.environment.launchArgs ?? [];
      const modelsIndex = args.indexOf('--models-directory');
      const modelsRoot =
        modelsIndex >= 0
          ? args[modelsIndex + 1]
          : args.find((arg) => arg.startsWith('--models-directory='))?.slice('--models-directory='.length);
      if (modelsRoot) writableRoots.push(modelsRoot);
      const reuseOnlyPaths = components
        .filter((component) => !writableRoots.some((root) => withinDirectory(root, component.path)))
        .map((component) => component.path);
      return comfyInstallPlanSchema.parse({
        ...identity,
        components,
        targetRoot,
        downloadBytes: bytes,
        requiredBytes:
          bytes + Math.max(request.intent === 'repair' ? 2 * 2 ** 30 : 256 * 2 ** 20, Math.ceil(bytes * 0.1)),
        reason: 'Revalidate or repair the existing pinned profile without changing its identity or recipe',
        evidence: [
          `existing-profile:${identity.id}`,
          'profile-recipe:preserved',
          ...runtime.evidence,
          ...(legacy ? [H3_PORTABLE_INSTALL_EVIDENCE] : []),
        ],
        workflow,
        workflowSource,
        reuseOnlyPaths,
        commands: runtime.commands,
        smokeInput: smokeInput(baseline, identity.bindings, options),
        repair: request.intent === 'repair',
      });
    }

    if (request.family === 'h3') {
      const candidate = catalog.candidates.find((entry) => entry.id === 'h3-matlowai-existing-bundle-discovery');
      if (!candidate || !options.h3BundleRoot) throw new Error('COMFY_TOOL_NOT_READY:H3_PINNED_BUNDLE_RECIPE');
      return comfyInstallPlanSchema.parse(createLegacyH3InstallPlan(options.h3BundleRoot(), candidate, report));
    }
    const kernels =
      report.runtime.status === 'available' && report.runtime.accelerator === 'cuda'
        ? await (options.probeKernels ?? ((python) => probePlanningKernels(python, options.runCommand)))(
            report.runtime.executable ?? initial.python!
          )
        : undefined;
    const candidate = selectComfyCandidate(
      catalog.candidates.filter((entry) => entry.family === request.family),
      report,
      kernels,
      request.profileId && !requestedProfile ? request.profileId : undefined
    );
    const baseline = baselineFor(catalog, candidate);
    const nodes = records(baseline.requiredNodes).map((node) => ({
      id: stringValue(node.id),
      version: stringValue(node.version),
    }));
    if (nodes.some((node) => !['ComfyUI', 'comfyui-core'].includes(node.id)))
      throw new Error('COMFY_DETECTION_INCOMPLETE:FIXED_CUSTOM_NODE_INSTALL_RECIPE_REQUIRED');
    const coreRevision = nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version;
    if (!coreRevision || !/^[a-f\d]{40}$/i.test(coreRevision)) throw new Error('COMFY_TOOL_NOT_READY:CORE_REVISION');
    // A different core gets its own managed runtime, preserving running and
    // externally managed ComfyUI installations and their verified profiles.
    const matched =
      report.comfy.revision === coreRevision &&
      report.runtime.status === 'available' &&
      report.runtime.accelerator === 'cuda';
    const targetRoot = matched ? initial.root : path.join(options.dataDir, 'comfy-runtimes', coreRevision.slice(0, 12));
    const root = matched ? initial.root : path.join(targetRoot, 'ComfyUI');
    const environment: ComfyProfile['environment'] = matched
      ? {
          root,
          python: report.runtime.executable ?? initial.python!,
          baseUrl: initial.baseUrl ?? 'http://127.0.0.1:8188',
        }
      : {
          root,
          python: path.join(targetRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
          baseUrl: `http://127.0.0.1:${18188 + (Number.parseInt(coreRevision.slice(0, 3), 16) % 1000)}`,
        };
    let runtime: Awaited<ReturnType<typeof prepareComfyRuntime>> = {
      commands: [],
      components: [],
      evidence: ['runtime:existing-matching-core'],
    };
    if (!matched) {
      report = await probe({
        root,
        python: environment.python,
        baseUrl: environment.baseUrl,
        runCommand: options.runCommand,
        fetchImpl: options.fetchImpl,
      });
      assertPlanningHardware(report);
      const bootstrapPython = await findBootstrapPython(options, initial.python);
      runtime = await (options.prepareRuntime ?? prepareComfyRuntime)(
        {
          coreRevision,
          environment,
          targetRoot,
          report,
          bootstrapPython,
          runtimePins: record(candidate.runtimePins),
          existing: fs.existsSync(path.join(root, 'main.py')),
        },
        options
      );
    }
    const models = await modelComponents(candidate, root, options);
    const components = [...models, ...runtime.components];
    const bytes = components.reduce((sum, component) => sum + (component.sizeBytes ?? 0), 0);
    const recipeIdentity = JSON.stringify({
      environment,
      components,
      nodes,
      bindings: baseline.bindings,
      defaults: baseline.defaults,
    });
    const id = `${stringValue(candidate.id).replace(/-discovery$/, '')}-${crypto.createHash('sha256').update(recipeIdentity).digest('hex').slice(0, 12)}`;
    return comfyInstallPlanSchema.parse({
      id,
      family: request.family,
      name: stringValue(candidate.id).replace(/-discovery$/, ''),
      kind: comfyFamilyKind(request.family),
      version: stringValue(record(candidate.workflow).revision, coreRevision),
      quantization: stringValue(
        candidate.quantization,
        models.map((component) => `${component.role}:${component.precision}`).join(' + ')
      ),
      capabilities: baseline.capabilities,
      environment,
      components,
      nodes,
      workflowPath: path.join(targetRoot, 'openh3-workflows', `${stringValue(candidate.id)}.api.json`),
      workflowSha256: graphHash(baseline.graph),
      bindings: baseline.bindings,
      defaults: baseline.defaults,
      targetRoot,
      downloadBytes: bytes,
      requiredBytes: bytes + Math.max(4 * 2 ** 30, Math.ceil(bytes * 0.1)),
      reason: 'Complete recipe selected from measured hardware, component memory budget and executing kernel evidence',
      evidence: [
        `candidate:${candidate.id}`,
        `device:${report.machine.gpus.map((gpu) => `${gpu.vendor}:${gpu.computeCapability}:${gpu.totalMemoryBytes}`).join(',')}`,
        `planning-budget:weights=${models.reduce((sum, component) => sum + (component.sizeBytes ?? 0), 0)};available-ram=${report.machine.freeMemoryBytes}`,
        ...(kernels ? [`kernel-probe:${JSON.stringify(kernels)}`] : ['kernel-probe:pending-new-runtime']),
        ...runtime.evidence,
        'registration:requires-real-generation-and-artifact-validation',
      ],
      workflow: baseline.graph,
      commands: runtime.commands,
      smokeInput: smokeInput(baseline, record(baseline.bindings) as ComfyProfile['bindings'], options),
      repair: false,
    });
  };
}

export function defaultComfyInstallPlanner(dataDir: string, options: Omit<ComfyInstallPlannerOptions, 'dataDir'> = {}) {
  return createComfyInstallPlanner({ dataDir, ...options });
}
