import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyComfySmokeArtifact, type ComfySmokeContext } from '@/process/services/media/comfy/mediaValidation';
import { resolveMediaBinary } from '@/process/services/media/mediaBinary';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-media-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function video(
  name: string,
  source: string,
  audio: boolean | string = false,
  duration = '1',
  audioFormat: { sampleRate?: number; channels?: number } = {}
): string {
  const target = path.join(root, name);
  execFileSync(
    resolveMediaBinary('ffmpeg'),
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      source,
      ...(audio
        ? ['-f', 'lavfi', '-i', typeof audio === 'string' ? audio : 'sine=frequency=440:sample_rate=8000:duration=1']
        : []),
      '-t',
      duration,
      '-c:v',
      'mpeg4',
      '-q:v',
      '3',
      '-pix_fmt',
      'yuv420p',
      ...(audio
        ? ['-c:a', 'aac', '-ar', String(audioFormat.sampleRate ?? 8000), '-ac', String(audioFormat.channels ?? 1)]
        : []),
      target,
    ],
    { windowsHide: true, timeout: 30_000, stdio: 'pipe' }
  );
  return target;
}
function context(overrides: Partial<ComfySmokeContext['input']> = {}, audio = false): ComfySmokeContext {
  return {
    profile: {
      id: 'media',
      family: 'h3',
      name: 'H3 media fixture',
      kind: 'video',
      version: '1',
      quantization: 'fixture',
      capabilities: ['text-to-video', ...(audio ? ['native-audio'] : [])],
      state: 'downloaded',
      environment: { root, python: path.join(root, 'python'), baseUrl: 'http://127.0.0.1:8188' },
      components: [],
      nodes: [],
      workflowPath: path.join(root, 'workflow.json'),
      defaults: {},
      bindings: {
        width: [{ nodeId: '1', input: 'width' }],
        height: [{ nodeId: '1', input: 'height' }],
        durationSeconds: [{ nodeId: '1', input: 'duration' }],
      },
    },
    input: { prompt: 'a moving test pattern', width: 96, height: 64, durationSeconds: 1, ...overrides },
  };
}
const validate = (file: string, evidence = context()) =>
  verifyComfySmokeArtifact({ path: file, mimeType: 'video/mp4' }, 'video', new AbortController().signal, evidence);

describe('representative Comfy smoke media validation', () => {
  it('decodes distributed video frames and the promised native audio against submitted dimensions and duration', async () => {
    const file = video('moving.mp4', 'testsrc2=size=96x64:rate=12:duration=1', true);
    await expect(validate(file, context({}, true))).resolves.toBeUndefined();
  });
  it('rejects a playable frozen clip and a black clip', async () => {
    const frozen = video('frozen.mp4', 'smptebars=size=96x64:rate=12:duration=1');
    const blank = video('blank.mp4', 'color=black:size=96x64:rate=12:duration=1');
    await expect(validate(frozen)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    await expect(validate(blank)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('rejects missing promised audio or mismatched bound dimensions/duration', async () => {
    const file = video('moving.mp4', 'testsrc2=size=96x64:rate=12:duration=1');
    await expect(validate(file, context({}, true))).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    await expect(validate(file, context({ width: 128 }))).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    await expect(validate(file, context({ durationSeconds: 3 }))).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('requires an Omni soundtrack even when a profile omits the audio capability flag', async () => {
    const evidence = context();
    evidence.profile.family = 'fasth3-omni';
    const silent = video('silent-omni.mp4', 'testsrc2=size=96x64:rate=12:duration=1');
    await expect(validate(silent, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    const audible = video('audible-omni.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true, '1', {
      sampleRate: 32000,
      channels: 2,
    });
    await expect(validate(audible, evidence)).resolves.toBeUndefined();
  });
  it('rejects an Omni soundtrack containing only silent PCM samples', async () => {
    const evidence = context();
    evidence.profile.family = 'fasth3-omni';
    const file = video(
      'zero-audio.mp4',
      'testsrc2=size=96x64:rate=24:duration=1',
      'anullsrc=r=32000:cl=stereo:d=1',
      '1',
      { sampleRate: 32000, channels: 2 }
    );
    await expect(validate(file, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('rejects a soundtrack that ends before the generated video', async () => {
    const evidence = context({}, true);
    const file = video(
      'short-audio.mp4',
      'testsrc2=size=96x64:rate=24:duration=1',
      'sine=frequency=440:sample_rate=8000:duration=0.2'
    );
    await expect(validate(file, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('checks the Omni output duration when its workflow binds only a frame count', async () => {
    const evidence = context({ durationSeconds: 5 });
    evidence.profile.family = 'fasth3-omni';
    evidence.profile.bindings = { frames: [{ nodeId: '1', input: 'length' }] };
    const file = video('short-omni.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true);
    await expect(validate(file, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('accepts the 17n + 5 frame alignment and audio that starts after a silent intro', async () => {
    const evidence = context({ durationSeconds: 5 });
    evidence.profile.family = 'fasth3-omni';
    evidence.profile.bindings = { frames: [{ nodeId: '1', input: 'length' }] };
    evidence.profile.defaults = { fps: 24, frameMultiple: 17, frameOffset: 5 };
    const file = video(
      'aligned-omni.mp4',
      'testsrc2=size=96x64:rate=24:duration=5.166667',
      'sine=frequency=440:sample_rate=32000:duration=2.166667,adelay=3000',
      '5.166667',
      { sampleRate: 32000, channels: 2 }
    );
    await expect(validate(file, evidence)).resolves.toBeUndefined();
  });
  it('requires Omni native audio to be 32-kHz stereo', async () => {
    const evidence = context();
    evidence.profile.family = 'fasth3-omni';
    const mono = video('mono-omni.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true);
    const lowRate = video('low-rate-omni.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true, '1', {
      sampleRate: 24000,
      channels: 2,
    });
    await expect(validate(mono, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    await expect(validate(lowRate, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
  });
  it('does not invent dimensions for a workflow whose canvas is selected from its input image', async () => {
    const file = video('moving.mp4', 'testsrc2=size=96x64:rate=12:duration=1');
    const evidence = context({ width: 1024, height: 1024 });
    evidence.profile.bindings = {};
    await expect(validate(file, evidence)).resolves.toBeUndefined();
  });
});

describe('requested Comfy generation media validation', () => {
  it.each(['black', 'white'])('accepts a valid %s image requested by the user', async (color) => {
    const file = path.join(root, `${color}.png`);
    execFileSync(
      resolveMediaBinary('ffmpeg'),
      ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:size=96x64`, '-frames:v', '1', file],
      { windowsHide: true, timeout: 30_000, stdio: 'pipe' }
    );
    const evidence = { ...context(), mode: 'generation' as const };
    evidence.profile.kind = 'image';
    evidence.profile.family = 'z-image';
    await expect(
      verifyComfySmokeArtifact({ path: file, mimeType: 'image/png' }, 'image', new AbortController().signal, evidence)
    ).resolves.toBeUndefined();
    await expect(
      verifyComfySmokeArtifact({ path: file, mimeType: 'image/png' }, 'image', new AbortController().signal, {
        profile: evidence.profile,
        input: evidence.input,
      })
    ).rejects.toThrow('COMFY_SMOKE_IMAGE_INVALID');
  });
  it.each([
    { name: 'color bars', source: 'smptebars=size=96x64:rate=12:duration=1' },
    { name: 'black', source: 'color=black:size=96x64:rate=12:duration=1' },
  ])('accepts a valid static $name video', async ({ source }) => {
    const file = video('static.mp4', source);
    await expect(validate(file, { ...context(), mode: 'generation' as const })).resolves.toBeUndefined();
  });
  it('accepts synchronized silent Omni audio while retaining the required native soundtrack', async () => {
    const evidence = { ...context(), mode: 'generation' as const };
    evidence.profile.family = 'fasth3-omni';
    const file = video(
      'silent-generation.mp4',
      'testsrc2=size=96x64:rate=24:duration=1',
      'anullsrc=r=32000:cl=stereo:d=1',
      '1',
      { sampleRate: 32000, channels: 2 }
    );
    await expect(validate(file, evidence)).resolves.toBeUndefined();
  });
  it('still rejects undecodable output and mismatched requested dimensions or duration', async () => {
    const evidence = { ...context(), mode: 'generation' as const };
    const invalid = path.join(root, 'invalid.mp4');
    fs.writeFileSync(invalid, 'not a video');
    await expect(validate(invalid, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID');
    const file = video('static.mp4', 'smptebars=size=96x64:rate=12:duration=1');
    await expect(validate(file, { ...evidence, input: { ...evidence.input, width: 128 } })).rejects.toThrow(
      'COMFY_SMOKE_VIDEO_INVALID'
    );
    await expect(validate(file, { ...evidence, input: { ...evidence.input, durationSeconds: 3 } })).rejects.toThrow(
      'COMFY_SMOKE_VIDEO_INVALID'
    );
  });
  it('still requires Omni audio presence, format, frame rate, and synchronization', async () => {
    const evidence = { ...context(), mode: 'generation' as const };
    evidence.profile.family = 'fasth3-omni';
    const absent = video('absent.mp4', 'testsrc2=size=96x64:rate=24:duration=1');
    const mono = video('mono.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true);
    const lowRate = video('low-rate.mp4', 'testsrc2=size=96x64:rate=24:duration=1', true, '1', {
      sampleRate: 24000,
      channels: 2,
    });
    const wrongFps = video('wrong-fps.mp4', 'testsrc2=size=96x64:rate=12:duration=1', true, '1', {
      sampleRate: 32000,
      channels: 2,
    });
    const short = video(
      'short.mp4',
      'testsrc2=size=96x64:rate=24:duration=1',
      'sine=frequency=440:sample_rate=32000:duration=0.2',
      '1',
      { sampleRate: 32000, channels: 2 }
    );
    await Promise.all(
      [absent, mono, lowRate, wrongFps, short].map((file) =>
        expect(validate(file, evidence)).rejects.toThrow('COMFY_SMOKE_VIDEO_INVALID')
      )
    );
  });
});
