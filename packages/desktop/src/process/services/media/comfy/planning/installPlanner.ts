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
import { probeComfyEnvironment, readPythonRuntime, type ComfyEnvironmentReport } from '../discovery/environment';
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
import {
  approvedComfyTransports,
  isTrustedComfySource,
  resolveComfyTransports,
  type selectComfyTransports,
} from './transportSelection';
import { ensureComfySmokeReference } from './smokeReference';
import { installationEnvironments, runtimeCompatibility, sameEnvironmentPath } from './environmentSelection';
import { createLegacyH3InstallPlan, H3_PORTABLE_INSTALL_EVIDENCE } from './legacyInstallPlan';

export type ComfyInstallPlannerOptions = RuntimePreparationOptions & {
  dataDir: string;
  resourcesRoot?: string;
  roots?: () => string[];
  applicationRoots?: () => string[];
  h3BundleRoot?: () => string;
  endpoints?: () => string[];
  probe?: typeof probeComfyEnvironment;
  loadCatalog?: () => ComfyInstallCatalog;
  probeKernels?: (python: string) => Promise<ComfyKernelEvidence>;
  prepareRuntime?: typeof prepareComfyRuntime;
  selectTransports?: typeof selectComfyTransports;
};

export type ComfyInstallPlanningContext = {
  /** Application-observed schema failures; never supplied by model tool arguments. */
  excludedEnvironmentRoots?: string[];
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
/** Recognize the registered profile's managed layout independently of the directory chosen for new installs. */
function managedRuntimeRoot(profile: ComfyProfile, coreRevision?: string): string | undefined {
  if (!coreRevision || !/^[a-f\d]{40}$/i.test(coreRevision)) return undefined;
  const root = path.dirname(path.resolve(profile.environment.root));
  const dataRoot = path.dirname(path.dirname(root));
  if (
    !sameEnvironmentPath(path.dirname(root), path.join(dataRoot, 'comfy-runtimes')) ||
    !new RegExp(`^${coreRevision.slice(0, 12)}(?:-[a-f\\d]{12})?$`, 'i').test(path.basename(root))
  )
    return undefined;
  const venv = path.basename(path.dirname(path.dirname(profile.environment.python)));
  if (!/^\.venv(?:-py3(?:10|11|12|13))?$/.test(venv)) return undefined;
  const python = path.join(root, venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (
    path.relative(path.join(root, 'ComfyUI'), profile.environment.root) !== '' ||
    path.relative(python, profile.environment.python) !== '' ||
    !withinDirectory(path.join(root, 'openh3-workflows'), profile.workflowPath)
  )
    return undefined;
  const actualDataRoot = fs.realpathSync(dataRoot);
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
async function matchingLocalComponent(file: string, sha256: string, size: number): Promise<boolean> {
  try {
    if (!fs.statSync(file).isFile() || fs.statSync(file).size !== size) return false;
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex') === sha256.toLowerCase();
  } catch {
    return false;
  }
}
async function modelComponents(
  candidate: CatalogRecord,
  root: string,
  options: ComfyInstallPlannerOptions,
  sourceOverrides: ComfyInstallIdentityRequest['sourceOverrides'] = [],
  modelsRoot = path.join(root, 'models')
): Promise<ComfyProfile['components']> {
  const candidateComponents = records(candidate.components);
  for (const override of sourceOverrides ?? []) {
    if (!candidateComponents.some((item) => stringValue(item.name) === override.component))
      throw new Error(`COMFY_SOURCE_COMPONENT_UNKNOWN:${override.component}`);
    if (override.urls.some((url) => !isTrustedComfySource(url)))
      throw new Error(`COMFY_SOURCE_CANDIDATE_NOT_TRUSTED:${override.component}`);
  }
  const resolved = await Promise.all(
    candidateComponents.map(async (item) => {
      const directory = stringValue(item.directory),
        name = stringValue(item.name);
      if (!directory || path.basename(directory) !== directory || !name || path.basename(name) !== name)
        throw new Error('COMFY_TOOL_NOT_READY:CATALOG_MODEL_PATH');
      const file = path.join(modelsRoot, directory, name);
      const present = await matchingLocalComponent(file, stringValue(item.sha256), Number(item.sizeBytes));
      const urls = present
        ? approvedComfyTransports(item)
        : await (options.selectTransports ?? resolveComfyTransports)(
            item,
            options.fetchImpl,
            sourceOverrides?.find((override) => override.component === name)?.urls ?? []
          );
      return {
        role: stringValue(item.role),
        name,
        path: file,
        version: stringValue(item.revision),
        precision: stringValue(item.precision),
        url: urls[0],
        sourceUrls: urls,
        sha256: stringValue(item.sha256),
        sizeBytes: Number(item.sizeBytes),
      };
    })
  );
  const missing = (sourceOverrides ?? []).filter(
    (override) => !candidateComponents.some((item) => stringValue(item.name) === override.component)
  );
  if (missing.length) throw new Error('COMFY_SOURCE_COMPONENT_UNKNOWN:' + missing[0].component);
  return resolved;
}

/** Identity-only card requests become immutable, host-specific executable plans. */
export function createComfyInstallPlanner(options: ComfyInstallPlannerOptions) {
  return async (
    requestId: string,
    request: ComfyInstallIdentityRequest,
    profiles: readonly ComfyProfile[] = [],
    context: ComfyInstallPlanningContext = {}
  ): Promise<ComfyInstallPlan> => {
    const installDirectory = request.installContext?.installDirectory;
    const newInstallRoot = installDirectory ?? options.dataDir;
    const catalog = (options.loadCatalog ?? (() => loadComfyInstallCatalog(options.resourcesRoot)))();
    const requestedProfile = request.profileId
      ? profiles.find((profile) => profile.id === request.profileId)
      : undefined;
    if (requestedProfile && requestedProfile.family !== request.family)
      throw new Error('COMFY_INSTALL_PROFILE_FAMILY_MISMATCH');
    const familyProfiles = profiles.filter((profile) => profile.family === request.family);
    let existingProfile =
      request.intent === 'install-other'
        ? undefined
        : (requestedProfile ??
          (request.intent === 'repair'
            ? familyProfiles[0]
            : familyProfiles.find((profile) => profile.state !== 'invalid')));
    if (existingProfile && installDirectory && request.intent !== 'repair' && !request.profileId) {
      const complete = await Promise.all(
        existingProfile.components.map((component) =>
          matchingLocalComponent(component.path, component.sha256 ?? '', component.sizeBytes ?? 0)
        )
      );
      if (complete.some((present) => !present)) existingProfile = undefined;
    }
    const excluded = (root: string): boolean =>
      Boolean(context.excludedEnvironmentRoots?.some((entry) => sameEnvironmentPath(entry, root)));
    if (
      existingProfile &&
      !request.profileId &&
      request.intent === 'install' &&
      excluded(existingProfile.environment.root)
    )
      existingProfile = undefined;
    if (request.intent === 'repair' && !existingProfile)
      throw new Error('COMFY_DETECTION_INCOMPLETE:REPAIR_PROFILE_NOT_FOUND');
    const roots = [
      ...new Set([
        ...(options.roots?.() ?? []),
        ...profiles.map((profile) => profile.environment.root),
        options.dataDir,
        newInstallRoot,
      ]),
    ];
    const discovered = await installationEnvironments(
      roots,
      profiles,
      options.fetchImpl ?? fetch,
      options.endpoints?.(),
      options.applicationRoots?.()
    );
    let initial = existingProfile?.environment ?? discovered[0] ?? { root: newInstallRoot };
    const probe = options.probe ?? probeComfyEnvironment;
    let report = await probe({
      root: initial.root,
      installDirectory,
      python: initial.python,
      baseUrl: initial.baseUrl,
      runCommand: options.runCommand,
      fetchImpl: options.fetchImpl,
    });
    assertPlanningHardware(report);

    if (existingProfile && !request.profileId && request.intent === 'install') {
      const candidate = candidateForProfile(catalog, existingProfile);
      if (candidate?.apiBaselineId) {
        const baseline = baselineFor(catalog, candidate);
        const expected =
          existingProfile.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version ?? '';
        const compatibility = await runtimeCompatibility(
          { ...existingProfile.environment, root: existingProfile.environment.root, reason: 'configured' },
          report,
          baseline,
          candidate,
          expected,
          options.fetchImpl ?? fetch
        );
        if (
          compatibility.status === 'incompatible' ||
          (compatibility.status === 'compatible' && compatibility.revision !== expected)
        )
          existingProfile = undefined;
      }
    }

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
      const { state: _state, validation: _validation, ...identity } = structuredClone(existingProfile);
      if (candidate && report.comfy.revision && report.runtime.status === 'available') {
        const core = identity.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id));
        if (core && core.version !== report.comfy.revision) {
          const compatibility = await runtimeCompatibility(
            { ...identity.environment, root: identity.environment.root, reason: 'configured' },
            report,
            { ...baseline, graph: workflow, bindings: identity.bindings },
            candidate,
            core.version,
            options.fetchImpl ?? fetch
          );
          if (compatibility.status !== 'compatible')
            throw new Error(
              `COMFY_EXISTING_ENVIRONMENT_NEEDS_DIAGNOSIS:${JSON.stringify({ ...identity.environment, reason: compatibility.reason })}`
            );
          if (request.intent !== 'repair') throw new Error('COMFY_EXISTING_PROFILE_REVISION_CHANGED_REPAIR_REQUIRED');
          core.version = compatibility.revision!;
        }
      }
      let runtime: Awaited<ReturnType<typeof prepareComfyRuntime>> = { commands: [], components: [], evidence: [] };
      const coreRevision = identity.nodes.find((node) => ['ComfyUI', 'comfyui-core'].includes(node.id))?.version;
      const legacy = existingProfile.family === 'h3' && coreRevision === 'v0.35.0';
      const managedRoot = managedRuntimeRoot(existingProfile, coreRevision);
      if (
        !legacy &&
        request.intent === 'repair' &&
        (report.runtime.status !== 'available' || report.runtime.accelerator !== 'cuda')
      ) {
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
        ...identity.components
          .filter((item) => !runtime.components.some((wheel) => wheel.path === item.path))
          .map((item) => ({ ...item, sourceUrls: item.sourceUrls ? [...item.sourceUrls] : undefined })),
        ...runtime.components,
      ];
      for (const override of request.sourceOverrides ?? []) {
        const component = components.find((item) => item.name === override.component);
        if (!component || !component.sha256 || !component.sizeBytes)
          throw new Error(`COMFY_SOURCE_COMPONENT_UNKNOWN:${override.component}`);
        if (override.urls.some((url) => !isTrustedComfySource(url)))
          throw new Error(`COMFY_SOURCE_CANDIDATE_NOT_TRUSTED:${override.component}`);
        const urls = await (options.selectTransports ?? resolveComfyTransports)(
          { ...component },
          options.fetchImpl,
          override.urls
        );
        component.url = urls[0];
        component.sourceUrls = urls;
      }
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
        legacy && path.basename(path.dirname(identity.environment.root)) === 'ComfyUI_windows_portable'
          ? path.resolve(identity.environment.root, '../../..')
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
      const bundleRoot = installDirectory ? path.join(installDirectory, 'h3-bundle') : options.h3BundleRoot?.();
      if (!candidate || !bundleRoot) throw new Error('COMFY_TOOL_NOT_READY:H3_PINNED_BUNDLE_RECIPE');
      return comfyInstallPlanSchema.parse(createLegacyH3InstallPlan(bundleRoot, candidate, report));
    }
    let kernels: ComfyKernelEvidence | undefined;
    const candidate = selectComfyCandidate(
      catalog.candidates.filter((entry) => entry.family === request.family),
      report,
      undefined,
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
    // Inspect every installation; a commit difference alone is not incompatibility.
    let matched = false;
    const environmentEvidence: string[] = [];
    const unresolved: string[] = [];
    const blockedRoots = new Set<string>();
    let workflowIncompatible = Boolean(context.excludedEnvironmentRoots?.length);
    for (const environment of discovered) {
      if (excluded(environment.root)) {
        workflowIncompatible = true;
        blockedRoots.add(environment.root);
        environmentEvidence.push(`environment:${environment.root}:incompatible:PREVIOUS_WORKFLOW_SCHEMA_FAILURE`);
        continue;
      }
      try {
        const observed = await probe({
          ...environment,
          installDirectory,
          runCommand: options.runCommand,
          fetchImpl: options.fetchImpl,
        });
        const compatibility = await runtimeCompatibility(
          environment,
          observed,
          baseline,
          candidate,
          coreRevision,
          options.fetchImpl ?? fetch
        );
        environmentEvidence.push(`environment:${environment.root}:${compatibility.status}:${compatibility.reason}`);
        if (
          compatibility.status === 'unknown' &&
          withinDirectory(path.join(newInstallRoot, 'comfy-runtimes'), environment.root) &&
          observed.comfy.revision === coreRevision &&
          (observed.runtime.status !== 'available' || observed.runtime.accelerator !== 'cuda')
        ) {
          environmentEvidence.push(`runtime:resume-managed-dependencies:${environment.root}`);
          continue;
        }
        if (compatibility.status === 'unknown') {
          blockedRoots.add(environment.root);
          unresolved.push(JSON.stringify({ ...environment, reason: compatibility.reason }));
          continue;
        }
        if (compatibility.status !== 'compatible') {
          workflowIncompatible = true;
          blockedRoots.add(environment.root);
          continue;
        }
        const observedKernels = await (
          options.probeKernels ?? ((python) => probePlanningKernels(python, options.runCommand))
        )(observed.runtime.executable ?? environment.python!);
        selectComfyCandidate([candidate], observed, observedKernels);
        initial = environment;
        report = observed;
        kernels = observedKernels;
        for (const node of nodes)
          if (['ComfyUI', 'comfyui-core'].includes(node.id)) node.version = compatibility.revision!;
        matched = true;
        environmentEvidence.push(`runtime:reused:${compatibility.reason}`);
        break;
      } catch (error) {
        blockedRoots.add(environment.root);
        unresolved.push(
          JSON.stringify({
            ...environment,
            reason: error instanceof Error ? error.message : 'ENVIRONMENT_PROBE_FAILED',
          })
        );
      }
    }
    if (!matched && unresolved.length) {
      // An unidentified installation is never a write target. It must not block
      // an ordinary install into a separate, pinned application-owned runtime.
      if (request.intent === 'repair' || request.profileId || !workflowIncompatible)
        throw new Error(`COMFY_EXISTING_ENVIRONMENT_NEEDS_DIAGNOSIS:${unresolved.join(';')}`);
      environmentEvidence.push(`runtime:isolated-after-unconfirmed-environments:${unresolved.join(';')}`);
    }
    const bootstrapPython = matched ? undefined : await findBootstrapPython(options, initial.python);
    const bootstrapRuntime = bootstrapPython
      ? await readPythonRuntime(bootstrapPython, { runCommand: options.runCommand })
      : undefined;
    const pythonAbi = bootstrapRuntime?.version?.split('.').slice(0, 2).join('');
    if (!matched && !/^3(?:10|11|12|13)$/.test(pythonAbi ?? '')) throw new Error('COMFY_BOOTSTRAP_PYTHON_UNCONFIRMED');
    let targetRoot =
      matched && !installDirectory
        ? initial.root
        : path.join(newInstallRoot, 'comfy-runtimes', coreRevision.slice(0, 12));
    if (!matched && [...blockedRoots].some((blocked) => withinDirectory(targetRoot, blocked))) {
      targetRoot += `-${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 12)}`;
      if ([...blockedRoots].some((blocked) => withinDirectory(targetRoot, blocked)))
        throw new Error('COMFY_RUNTIME_ISOLATION_CONFLICT');
      environmentEvidence.push('runtime:isolated-path-conflict-avoided');
    }
    const root = matched ? initial.root : path.join(targetRoot, 'ComfyUI');
    const environment: ComfyProfile['environment'] = matched
      ? {
          ...profiles.find((profile) => sameEnvironmentPath(profile.environment.root, root))?.environment,
          root,
          python: report.runtime.executable ?? initial.python!,
          baseUrl: initial.baseUrl ?? 'http://127.0.0.1:8188',
        }
      : {
          root,
          python: path.join(
            targetRoot,
            `.venv-py${pythonAbi}`,
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'
          ),
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
        installDirectory,
        python: environment.python,
        baseUrl: environment.baseUrl,
        runCommand: options.runCommand,
        fetchImpl: options.fetchImpl,
      });
      assertPlanningHardware(report);
      runtime = await (options.prepareRuntime ?? prepareComfyRuntime)(
        {
          coreRevision,
          environment,
          targetRoot,
          report,
          bootstrapPython: bootstrapPython!,
          runtimePins: record(candidate.runtimePins),
          existing: fs.existsSync(path.join(root, 'main.py')),
        },
        options
      );
    }
    const launchArgs = environment.launchArgs ?? [];
    const modelsFlag = launchArgs.indexOf('--models-directory');
    let modelsRoot =
      (modelsFlag >= 0
        ? launchArgs[modelsFlag + 1]
        : launchArgs.find((arg) => arg.startsWith('--models-directory='))?.slice('--models-directory='.length)) ??
      path.join(root, 'models');
    if (matched && installDirectory) {
      const complete = await Promise.all(
        records(candidate.components).map((component) =>
          matchingLocalComponent(
            path.join(modelsRoot, stringValue(component.directory), stringValue(component.name)),
            stringValue(component.sha256),
            Number(component.sizeBytes)
          )
        )
      );
      if (complete.some((present) => !present)) {
        modelsRoot = path.join(installDirectory, 'models');
        environment.launchArgs = launchArgs.filter(
          (arg, index) =>
            arg !== '--models-directory' &&
            !arg.startsWith('--models-directory=') &&
            launchArgs[index - 1] !== '--models-directory'
        );
        environment.launchArgs.push('--models-directory', modelsRoot);
      }
    }
    const models = await modelComponents(candidate, root, options, request.sourceOverrides, modelsRoot);
    const components = [...models, ...runtime.components];
    const sizes = await Promise.all(
      components.map(async (component) =>
        (await matchingLocalComponent(component.path, component.sha256 ?? '', component.sizeBytes ?? 0))
          ? 0
          : (component.sizeBytes ?? 0)
      )
    );
    const bytes = sizes.reduce((sum, size) => sum + size, 0);
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
      kind: comfyFamilyKind(request.family, request.kind),
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
      reason: matched
        ? 'Reuse an existing compatible ComfyUI; install only missing recipe components and verify generation'
        : 'No compatible existing runtime; prepare an isolated runtime and verify generation',
      evidence: [
        `candidate:${candidate.id}`,
        `device:${report.machine.gpus.map((gpu) => `${gpu.vendor}:${gpu.computeCapability}:${gpu.totalMemoryBytes}`).join(',')}`,
        `planning-budget:weights=${models.reduce((sum, component) => sum + (component.sizeBytes ?? 0), 0)};available-ram=${report.machine.freeMemoryBytes}`,
        ...(kernels ? [`kernel-probe:${JSON.stringify(kernels)}`] : ['kernel-probe:pending-new-runtime']),
        ...environmentEvidence,
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
