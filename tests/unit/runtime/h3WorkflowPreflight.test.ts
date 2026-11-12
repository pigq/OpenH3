import { describe, it, expect } from 'vitest';
import {
  validateComfyWorkflow,
  validateComfyReferenceOutputPaths,
  type ComfyGraph,
} from '@/process/services/runtime/h3WorkflowPreflight';
const info = {
  Source: { input: { required: { model: [['model.bin']] } }, output: ['IMAGE'] },
  Sink: { input: { required: { image: ['IMAGE'] } }, output: [] },
};
describe('Comfy workflow preflight', () => {
  describe('reference output participation', () => {
    const registry = {
      Load: { output: ['IMAGE'] },
      Combine: { output: ['IMAGE'] },
      Save: { output: [], output_node: true },
    };
    const graph: ComfyGraph = {
      first: { class_type: 'Load', inputs: { image: 'first.png' } },
      second: { class_type: 'Load', inputs: { image: 'second.png' } },
      combine: { class_type: 'Combine', inputs: { a: ['first', 0], b: ['second', 0] } },
      output: { class_type: 'Save', inputs: { image: ['combine', 0] } },
      preview: { class_type: 'Save', inputs: { image: ['combine', 0] } },
      unused: { class_type: 'Load', inputs: { image: 'unused.png' } },
    };
    it('accepts shared reference ancestors across multiple declared outputs without requiring unused loaders', () => {
      expect(() => validateComfyReferenceOutputPaths(graph, registry, ['first', 'second'])).not.toThrow();
    });
    it('requires every used reference to reach an output, even when another reference is connected', () => {
      expect(() => validateComfyReferenceOutputPaths(graph, registry, ['first', 'unused'])).toThrow(
        'COMFY_REFERENCE_INPUT_DISCONNECTED:INVALID_INPUT:node=unused'
      );
    });
    it.each([undefined, false])('does not infer output nodes from class names or empty outputs (%s)', (output_node) => {
      expect(() =>
        validateComfyReferenceOutputPaths(graph, { ...registry, Save: { output: [], output_node } }, ['first'])
      ).toThrow('COMFY_REFERENCE_OUTPUT_UNCONFIRMED');
    });
    it('does not require output metadata for a request without reference inputs', () => {
      expect(() => validateComfyReferenceOutputPaths(graph, {}, [])).not.toThrow();
    });
  });

  it('expands required v3 autogrow groups using the live template', () => {
    const registry = {
      Math: {
        input: {
          required: {
            values: [
              'COMFY_AUTOGROW_V3',
              { template: { input: { required: { value: ['FLOAT,INT,BOOLEAN'] } }, names: ['a', 'b'], min: 1 } },
            ],
          },
        },
        output: ['FLOAT'],
      },
    };
    expect(() =>
      validateComfyWorkflow({ '1': { class_type: 'Math', inputs: { 'values.a': 0 } } }, registry)
    ).not.toThrow();
    expect(() => validateComfyWorkflow({ '1': { class_type: 'Math', inputs: {} } }, registry)).toThrow();
    expect(() => validateComfyWorkflow({ '1': { class_type: 'Math', inputs: { 'values.z': 0 } } }, registry)).toThrow();
  });
  it('checks v3 COMBO model options', () => {
    const registry = {
      Source: { input: { required: { model: ['COMBO', { options: ['model.bin'] }] } }, output: ['IMAGE'] },
    };
    expect(() =>
      validateComfyWorkflow({ '1': { class_type: 'Source', inputs: { model: 'absent.bin' } } }, registry)
    ).toThrow('INVALID_INPUT');
  });
  it('accepts a connected graph with installed model', () => {
    expect(() =>
      validateComfyWorkflow(
        {
          '1': { class_type: 'Source', inputs: { model: 'model.bin' } },
          '2': { class_type: 'Sink', inputs: { image: ['1', 0] } },
        },
        info
      )
    ).not.toThrow();
  });
  it.each([
    [{ '1': { class_type: 'Absent', inputs: {} } }, 'MISSING_NODE'],
    [{ '1': { class_type: 'Source', inputs: {} } }, 'INVALID_INPUT'],
    [{ '1': { class_type: 'Source', inputs: { model: 'missing.bin' } } }, 'INVALID_INPUT'],
    [{ '1': { class_type: 'Sink', inputs: { image: ['missing', 0] } } }, 'INVALID_INPUT'],
    [
      {
        '1': { class_type: 'Source', inputs: { model: 'model.bin' } },
        '2': { class_type: 'Sink', inputs: { image: ['1', 9] } },
      },
      'INVALID_INPUT',
    ],
  ])('rejects invalid environment/graph before submission', (graph, category) => {
    expect(() => validateComfyWorkflow(graph, info)).toThrow(category);
  });
  it('rejects cycles', () =>
    expect(() =>
      validateComfyWorkflow(
        { '1': { class_type: 'Sink', inputs: { image: ['1', 0] } } },
        { Sink: { ...info.Sink, output: ['IMAGE'] } }
      )
    ).toThrow('INVALID_INPUT'));
  it('checks flattened H3 image references against output type', () => {
    const graph = {
      '1': { class_type: 'Source', inputs: { model: 'model.bin' } },
      '2': { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { 'ref_images.ref_image_0': ['1', 0] } },
    };
    const registry = {
      ...info,
      MiniMaxH3ReferenceToVideo: { input: { optional: { ref_images: ['AUTOGROW'] } }, output: [] },
    };
    expect(() => validateComfyWorkflow(graph, registry)).not.toThrow();
    expect(() => validateComfyWorkflow(graph, { ...registry, Source: { ...info.Source, output: ['AUDIO'] } })).toThrow(
      'INVALID_INPUT'
    );
  });
});
