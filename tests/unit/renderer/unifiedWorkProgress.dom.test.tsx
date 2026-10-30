import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import type { ComfyGenerationJob, ComfyOperation } from '@/common/chat/document/creation/comfy';
import { createH3Job, type H3Job } from '@/common/chat/document/h3Job';
import type { CreationOperation } from '@/common/chat/document/creation/operation';

const mocks = vi.hoisted(() => ({
  activity: vi.fn(),
  authorize: vi.fn(),
  prefill: vi.fn(),
  h3Get: vi.fn(),
  h3Events: vi.fn(),
  h3Close: vi.fn(),
  creationOperation: vi.fn(),
  runtime: { isProcessing: false, hydrated: true, view: { pendingConfirmations: 0 } },
}));
vi.mock('@/common/chat/document/h3JobApi', () => ({
  h3JobApi: {
    get: mocks.h3Get,
    creationOperation: mocks.creationOperation,
    events: (id: string, update: (job: H3Job) => void) => {
      mocks.h3Events(id, update);
      return { close: mocks.h3Close };
    },
  },
}));
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/common/chat/document/creation/comfyApi', () => ({
  comfyApi: {
    activity: mocks.activity,
    authorize: mocks.authorize,
    operation: vi.fn(),
    job: vi.fn(),
  },
}));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({ requestConversationSendBoxPrefill: mocks.prefill }));
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => mocks.runtime,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      key === 'conversation.planBar.progress' ? `${values?.completed}/${values?.total}` : key,
  }),
}));
vi.mock('@/renderer/pages/conversation/explorer/ExplorerContainer', () => ({
  ExplorerContainer: ({ projectId }: { projectId: string }) => <div data-testid='explorer'>{projectId}</div>,
}));
vi.mock('@/renderer/pages/conversation/runtime/Creation/ComfyOperationResult', () => ({
  default: ({ id, conversationId }: { id: string; conversationId: string }) => (
    <div data-testid='installation-plan'>
      <span>Full pinned installation plan</span>
      <button onClick={() => void mocks.authorize(id, conversationId)}>Confirm existing operation</button>
    </div>
  ),
}));

import { MessageListProvider } from '@/renderer/pages/conversation/Messages/hooks';
import WorkProgressBridge from '@/renderer/pages/conversation/PlanBar/WorkProgressBridge';
import { resetH3JobsForTest } from '@/renderer/pages/conversation/runtime/Creation/useH3Jobs';
import ConversationWorkProgress from '@/renderer/pages/conversation/PlanBar/ConversationWorkProgress';
import {
  projectWorkProgress,
  publishWorkProgress,
  resetWorkProgressForTest,
} from '@/renderer/pages/conversation/PlanBar/workProgress';
import { ProjectPanelHost } from '@/renderer/components/layout/ProjectPanelHost';
import {
  setCurrentProject,
  resetCurrentProjectForTest,
} from '@/renderer/pages/conversation/explorer/currentProjectStore';
import {
  setCurrentConversation,
  resetCurrentConversationForTest,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

const operationId = '12345678-1234-1234-1234-123456789abc';
const jobId = '12345678-1234-1234-1234-123456789def';
const runtime = { isProcessing: false, pendingConfirmations: 0, hydrated: true };
const plan = (entries: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>): TMessage => ({
  id: 'plan',
  conversation_id: 'c1',
  type: 'plan',
  content: { session_id: 'c1', entries },
});
const tool = (id: string, name: string, status: 'running' | 'completed' | 'error', extra = {}): TMessage => ({
  id,
  conversation_id: 'c1',
  type: 'tool_call',
  content: { call_id: id, name, status, args: {}, ...extra },
});
const group = (state: 'Canceled' | 'Confirming' | 'Pending'): TMessage => ({
  id: 'g',
  conversation_id: 'c1',
  type: 'tool_group',
  content: [{ call_id: 'g:1', name: 'Worker', description: '', status: state, render_output_as_markdown: false }],
});
const operation = (state: ComfyOperation['state'] = 'paused'): ComfyOperation =>
  ({
    id: operationId,
    conversationId: 'c1',
    requestId: 'r1',
    state,
    plan: { name: 'Qwen-Edit' },
    progress: 'Downloading VAE',
    error: 'Connection interrupted',
    updatedAt: '2026-10-27T00:00:00Z',
  }) as ComfyOperation;
const job = (status: ComfyGenerationJob['status'] = 'succeeded'): ComfyGenerationJob => ({
  id: jobId,
  profileId: 'h3-int8',
  kind: 'video',
  status,
  progress: 100,
  artifacts: [],
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activity.mockResolvedValue({ operations: [], jobs: [] });
  mocks.authorize.mockResolvedValue(operation('running'));
  mocks.runtime.isProcessing = false;
  mocks.runtime.view.pendingConfirmations = 0;
});
afterEach(() => {
  cleanup();
  resetH3JobsForTest();
  resetWorkProgressForTest();
  resetCurrentProjectForTest();
  resetCurrentConversationForTest();
});

describe('unified work projection', () => {
  it('tracks the submitted H3 job instead of marking GPU work complete with its tool call', () => {
    const h3 = { ...createH3Job({ prompt: 'animate a photo' }, jobId), status: 'running' as const };
    const messages = [
      tool('submit', 'aionui_h3_generate_video', 'completed', {
        output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(h3) }] }),
      }),
      tool('poll', 'aionui_h3_job_status', 'completed', { output: JSON.stringify(h3) }),
    ];
    expect(projectWorkProgress(messages, runtime).tasks).toEqual([
      expect.objectContaining({
        id: `h3:${jobId}`,
        kind: 'generation',
        summaryKey: 'generateVideo',
        status: 'pending',
      }),
    ]);
    expect(projectWorkProgress(messages, runtime, [], [], [], [], { jobs: [h3], unavailable: [] }).tasks).toEqual([
      expect.objectContaining({ id: `h3:${jobId}`, status: 'running' }),
    ]);
    expect(
      projectWorkProgress(messages, runtime, [], [], [], [], {
        jobs: [{ ...h3, status: 'succeeded' }],
        unavailable: [],
      }).tasks[0].status
    ).toBe('completed');
    expect(
      projectWorkProgress(messages, runtime, [], [], [], [], { jobs: [h3], unavailable: [jobId] }).tasks[0].status
    ).toBe('interrupted');
    expect(
      projectWorkProgress(messages, runtime, [], [], [], [], {
        jobs: [{ ...h3, remoteUncertain: true }],
        unavailable: [],
      }).tasks[0].status
    ).toBe('interrupted');
  });
  it('does not create progress for simple questions, a one-step plan, or one completed shell command', () => {
    expect(
      projectWorkProgress(
        [{ id: 'q', type: 'text', conversation_id: 'c1', position: 'right', content: { content: 'hello' } }],
        runtime
      ).tasks
    ).toEqual([]);
    expect(projectWorkProgress([plan([{ content: 'Answer', status: 'completed' }])], runtime).tasks).toEqual([]);
    expect(projectWorkProgress([tool('bash', 'Bash', 'completed')], runtime).tasks).toEqual([]);
    expect(
      projectWorkProgress(
        [
          {
            id: 'one',
            conversation_id: 'c1',
            type: 'tool_group',
            content: [
              {
                call_id: 'read1',
                name: 'Read',
                description: 'README',
                status: 'Success',
                render_output_as_markdown: false,
              },
            ],
          },
        ],
        runtime
      ).tasks
    ).toEqual([]);
  });

  it('shows an active ComfyUI tool immediately with a human task summary', () => {
    const snapshot = projectWorkProgress([tool('generate', 'aionui_h3_generate_video', 'running')], {
      ...runtime,
      isProcessing: true,
    });

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ id: 'generate', status: 'running' });
    expect(snapshot.tasks[0].title).toBe('');
    expect(snapshot.tasks[0].summaryKey).toBe('generateVideo');
  });

  it('never exposes an opaque function identifier as a task title', () => {
    const snapshot = projectWorkProgress([tool('opaque', 'vendor_internal_step_v2', 'running')], {
      ...runtime,
      isProcessing: true,
    });

    expect(snapshot.tasks[0]).toMatchObject({ title: '', status: 'running' });
  });

  it('uses the live plan even when it has only one in-progress step', () => {
    const snapshot = projectWorkProgress([plan([{ content: '生成视频', status: 'in_progress' }])], {
      ...runtime,
      isProcessing: true,
    });

    expect(snapshot.tasks[0]).toMatchObject({ kind: 'plan', status: 'running' });
    expect(snapshot.tasks[0].children).toEqual([expect.objectContaining({ title: '生成视频', status: 'running' })]);
  });

  it('coalesces repeated job-status polls into one checklist item', () => {
    const messages = [
      tool('status-1', 'aionui_h3_job_status', 'completed', { args: { jobId: 'job-1' } }),
      tool('status-2', 'aionui_h3_job_status', 'running', { args: { jobId: 'job-1' } }),
    ];

    const tasks = projectWorkProgress(messages, { ...runtime, isProcessing: true }).tasks;

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'generation-status:job-1',
      summaryKey: 'waitForGeneration',
      status: 'running',
    });
  });

  it('keeps a structured plan as the checklist instead of adding tool calls as duplicate tasks', () => {
    const snapshot = projectWorkProgress(
      [
        plan([
          { content: '检查本地环境', status: 'completed' },
          { content: '生成视频', status: 'in_progress' },
        ]),
        tool('generate', 'aionui_h3_generate_video', 'running'),
      ],
      { ...runtime, isProcessing: true }
    );

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0].children?.map(({ title }) => title)).toEqual(['检查本地环境', '生成视频']);
  });

  it('does not leak completed tool calls from an earlier user turn into the current checklist', () => {
    const snapshot = projectWorkProgress(
      [
        tool('old', 'aionui_h3_generate_video', 'completed'),
        { id: 'user', conversation_id: 'c1', type: 'text', position: 'right', content: { content: '新问题' } },
        tool('current', 'aionui_h3_job_status', 'running', { args: { jobId: 'current-job' } }),
      ],
      { ...runtime, isProcessing: true }
    );

    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ id: 'generation-status:current-job', status: 'running' });
  });

  it('retains completed steps and marks unfinished foreground work interrupted after restart', () => {
    const snapshot = projectWorkProgress(
      [
        plan([
          { content: 'Detect GPU', status: 'completed' },
          { content: 'Install model', status: 'in_progress' },
          { content: 'Validate output', status: 'pending' },
        ]),
      ],
      runtime
    );
    expect(snapshot.tasks[0].status).toBe('interrupted');
    expect(snapshot.tasks[0].children?.map((item) => item.status)).toEqual(['completed', 'interrupted', 'pending']);
  });

  it('projects workflow children, subagents, detached Bash, and failed ACP exec without losing terminal status', () => {
    const messages: TMessage[] = [
      tool('agent', 'Task', 'completed', { description: 'Research node compatibility · subagent a1' }),
      tool('bash', 'Bash', 'running', {
        args: { run_in_background: true },
        description: 'Build frontend · bg task b1',
      }),
      {
        id: 'workflow',
        conversation_id: 'c1',
        type: 'tool_group',
        content: [
          {
            call_id: 'wf:1',
            name: 'Inspect',
            description: 'dependency audit',
            status: 'Success',
            render_output_as_markdown: false,
          },
          {
            call_id: 'wf:2',
            name: 'Build',
            description: 'compiler failure',
            status: 'Error',
            render_output_as_markdown: false,
          },
        ],
      },
      {
        id: 'acp',
        conversation_id: 'c1',
        type: 'acp_tool_call',
        content: {
          session_id: 'c1',
          update: {
            sessionUpdate: 'tool_call_update',
            tool_call_id: 'exec1',
            title: 'exec_command',
            kind: 'execute',
            status: 'failed',
          },
        },
      },
    ];
    const tasks = projectWorkProgress(messages, runtime).tasks;
    expect(tasks.find((item) => item.id === 'agent')).toMatchObject({ kind: 'subagent', status: 'completed' });
    expect(tasks.find((item) => item.id === 'bash')).toMatchObject({ kind: 'background', status: 'running' });
    expect(tasks.find((item) => item.id === 'workflow')).toMatchObject({ kind: 'workflow', status: 'failed' });
    expect(tasks.find((item) => item.id === 'workflow')?.children).toHaveLength(2);
    expect(tasks.find((item) => item.id === 'exec1')).toMatchObject({ kind: 'background', status: 'failed' });
  });

  it('does not restart an old plan when a different turn starts, and retains a recorded terminal failure', () => {
    const old = plan([
      { content: 'Inspect', status: 'completed' },
      { content: 'Run', status: 'in_progress' },
    ]);
    if (old.type === 'plan') old.content.turn_id = 'old-turn';
    expect(
      projectWorkProgress([old], { ...runtime, isProcessing: true, activeTurnId: 'new-turn' }).tasks[0].status
    ).toBe('interrupted');
    const failed: TMessage = {
      id: 'failed',
      conversation_id: 'c1',
      type: 'tips',
      content: { content: 'Command failed', type: 'error' },
    };
    expect(projectWorkProgress([old, failed], runtime).tasks[0].status).toBe('failed');
  });

  it('coalesces a completed workflow launch and its running roster into one task tree', () => {
    const snapshot = projectWorkProgress(
      [
        tool('wf', 'Workflow', 'completed'),
        {
          id: 'wf:1',
          conversation_id: 'c1',
          type: 'tool_group',
          content: [
            {
              call_id: 'wf:1',
              name: 'Analyze',
              description: 'Dependencies',
              status: 'Executing',
              render_output_as_markdown: false,
            },
          ],
        },
      ],
      { ...runtime, isProcessing: true }
    );
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({ id: 'wf', kind: 'workflow', status: 'running' });
    expect(snapshot.tasks[0].children?.[0].title).toBe('Analyze');
  });

  it('preserves cancelled, waiting and pending workflow aggregates across a new turn', () => {
    const nextTurn = { ...runtime, isProcessing: true, activeTurnId: 'new-turn' };
    expect(projectWorkProgress([group('Canceled')], nextTurn).tasks[0].status).toBe('cancelled');
    expect(projectWorkProgress([group('Confirming')], nextTurn).tasks[0].status).toBe('waiting');
    expect(projectWorkProgress([group('Pending')], nextTurn).tasks[0].status).toBe('pending');
  });

  it.each(['unifiedExecStartup', 'unifiedExecInteraction'])(
    'keeps %s process running after a clean turn and accepts its later terminal update',
    (source) => {
      // Exact passed-through shape from codex_conn::handle_thread_item; matches
      // session_agent::is_detached_exec_call and its startup/interaction regression.
      const running = tool('pty', 'Run build', 'running', {
        args: { type: 'commandExecution', source, command: 'bun run build' },
      });
      expect(projectWorkProgress([running], runtime).tasks[0]).toMatchObject({ kind: 'background', status: 'running' });
      const finished = tool('pty', 'Run build', 'completed', { args: { type: 'commandExecution', source } });
      expect(projectWorkProgress([finished], { ...runtime, isProcessing: true }).tasks[0]).toMatchObject({
        id: 'pty',
        status: 'completed',
      });
    }
  );

  it('shows waiting confirmation and handles uncertain generation as blocked instead of resubmitting', () => {
    const snapshot = projectWorkProgress(
      [
        plan([
          { content: 'Plan', status: 'completed' },
          { content: 'Execute', status: 'in_progress' },
        ]),
      ],
      { ...runtime, isProcessing: true, pendingConfirmations: 1 },
      [],
      [{ ...job('running'), submissionUncertain: true }]
    );
    expect(snapshot.tasks[0].status).toBe('waiting');
    expect(snapshot.tasks.find((item) => item.id === jobId)).toMatchObject({
      kind: 'generation',
      status: 'interrupted',
    });
    expect(snapshot.tasks.find((item) => item.id === jobId)?.operationId).toBeUndefined();
  });

  it('deduplicates native/ACP operation references and includes API-only recovered activities', () => {
    const messages = [
      tool('install', 'openh3_comfy_install', 'completed', {
        output: JSON.stringify({ comfyOperationId: operationId }),
      }),
      tool('again', 'openh3_comfy_install', 'completed', {
        output: JSON.stringify({
          content: [{ type: 'text', text: JSON.stringify({ comfyOperationId: operationId }) }],
        }),
      }),
    ];
    const tasks = projectWorkProgress(messages, runtime, [operation()], [job()]).tasks;
    expect(tasks.filter((item) => item.id === operationId)).toHaveLength(1);
    expect(tasks.find((item) => item.id === operationId)).toMatchObject({
      kind: 'install',
      status: 'interrupted',
      operationId,
    });
    expect(tasks.find((item) => item.id === jobId)).toMatchObject({ kind: 'generation', status: 'completed' });
  });

  it('shows preparation before an operation exists and distinguishes incomplete detection from hardware rejection', () => {
    const preparation = {
      requestId: 'request-1',
      conversationId: 'c1',
      family: 'qwen-edit' as const,
      intent: 'install' as const,
      status: 'detecting' as const,
      updatedAt: '2026-10-27T00:00:00Z',
    };
    expect(projectWorkProgress([], runtime, [], [], [], [preparation]).tasks[0]).toMatchObject({
      kind: 'install',
      status: 'running',
      preparing: true,
    });
    expect(
      projectWorkProgress(
        [],
        runtime,
        [],
        [],
        [],
        [{ ...preparation, status: 'failed', error: 'COMFY_DEVICE_CONDITIONS_INSUFFICIENT:disk' }]
      ).tasks[0]
    ).toMatchObject({
      status: 'failed',
      diagnosis: 'deviceInsufficient',
      detail: 'COMFY_DEVICE_CONDITIONS_INSUFFICIENT:disk',
    });
    expect(
      projectWorkProgress(
        [],
        runtime,
        [],
        [],
        [],
        [{ ...preparation, status: 'interrupted', error: 'COMFY_DETECTION_INCOMPLETE:python' }]
      ).tasks[0]
    ).toMatchObject({ status: 'interrupted', diagnosis: 'detectionIncomplete' });
  });
});

describe('work progress right-panel integration', () => {
  it('continues tracking a job submitted automatically after model installation without a new tool message', async () => {
    setCurrentConversation('c1');
    const installing: CreationOperation = {
      id: operationId,
      requestId: 'creation-request',
      conversationId: 'c1',
      state: 'installing',
      spec: { prompt: 'animate a photo' },
      updatedAt: '2026-10-30T00:00:00Z',
    };
    mocks.creationOperation.mockResolvedValue(installing);
    mocks.h3Get.mockResolvedValue(createH3Job(installing.spec, jobId));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MessageListProvider
          value={[
            tool('install', 'openh3_h3_install_video_model', 'completed', {
              output: JSON.stringify({
                content: [{ type: 'text', text: JSON.stringify({ creationOperationId: operationId }) }],
              }),
            }),
          ]}
        >
          <WorkProgressBridge conversationId='c1' />
        </MessageListProvider>
        <ConversationWorkProgress conversationId='c1' />
      </SWRConfig>
    );
    await waitFor(() => expect(mocks.creationOperation).toHaveBeenCalledWith(operationId));
    await waitFor(() =>
      expect(document.querySelector('[data-work-task="install"]')).toHaveAttribute('data-status', 'running')
    );
    expect(mocks.h3Events).not.toHaveBeenCalled();
    mocks.creationOperation.mockResolvedValue({ ...installing, state: 'submitted', jobId });
    await waitFor(() => expect(mocks.h3Events).toHaveBeenCalledOnce(), { timeout: 3500 });
    const update = mocks.h3Events.mock.calls[0][1];
    act(() => update({ ...createH3Job(installing.spec, jobId), status: 'running' }));
    await waitFor(() =>
      expect(document.querySelector('[data-work-task="generation"]')).toHaveAttribute('data-status', 'running')
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2');
  });
  it('follows the initial H3 submission through completion after the assistant turn has ended', async () => {
    setCurrentConversation('c1');
    const queued = createH3Job({ prompt: 'animate a photo' }, jobId);
    mocks.h3Get.mockResolvedValue(queued);
    const submitted = tool('submit', 'aionui_h3_generate_video', 'completed', {
      output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(queued) }] }),
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MessageListProvider value={[submitted]}>
          <WorkProgressBridge conversationId='c1' />
        </MessageListProvider>
        <ConversationWorkProgress conversationId='c1' />
      </SWRConfig>
    );
    await waitFor(() => expect(mocks.h3Events).toHaveBeenCalledOnce());
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    const update = mocks.h3Events.mock.calls[0][1];
    act(() => update({ ...queued, status: 'running' }));
    await waitFor(() =>
      expect(document.querySelector('[data-work-task="generation"]')).toHaveAttribute('data-status', 'running')
    );
    act(() => update({ ...queued, status: 'succeeded' }));
    await waitFor(() => expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1'));
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '1');
    expect(mocks.h3Get).toHaveBeenCalledWith(jobId);
    expect(mocks.prefill).not.toHaveBeenCalled();
    expect(mocks.h3Close).toHaveBeenCalledOnce();
  });
  it('bridges real message-provider data to a panel outside that provider and recovers API-only activities', async () => {
    setCurrentConversation('c1');
    mocks.activity.mockResolvedValue({ operations: [operation()], jobs: [job()] });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MessageListProvider
          value={[
            plan([
              { content: 'Detect GPU', status: 'completed' },
              { content: 'Install node', status: 'in_progress' },
            ]),
          ]}
        >
          <WorkProgressBridge conversationId='c1' />
        </MessageListProvider>
        <ConversationWorkProgress conversationId='c1' />
      </SWRConfig>
    );
    await waitFor(() => expect(screen.getByText('Detect GPU')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Qwen-Edit')).toBeInTheDocument());
    expect(screen.getByText('h3-int8')).toBeInTheDocument();
    expect(screen.getByText(/Connection interrupted/)).toBeInTheDocument();
    expect(mocks.activity).toHaveBeenCalledWith('c1');
    expect(mocks.authorize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('guid.comfy.operation.details'));
    expect(screen.getByTestId('installation-plan')).toHaveTextContent('Full pinned installation plan');
    expect(mocks.authorize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Confirm existing operation'));
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith(operationId, 'c1'));
    expect(mocks.prefill).not.toHaveBeenCalled();
  });

  it('uses the existing project host, preserves the Explorer mount, and switches back to Workspace', () => {
    setCurrentProject('p1');
    setCurrentConversation('c1');
    publishWorkProgress(
      'c1',
      projectWorkProgress(
        [
          plan([
            { content: 'Inspect', status: 'completed' },
            { content: 'Generate', status: 'in_progress' },
          ]),
        ],
        runtime
      )
    );
    render(<ProjectPanelHost widthPx={320} collapsed={false} />);
    expect(document.querySelectorAll('[data-project-panel-host]')).toHaveLength(1);
    expect(screen.getByTestId('conversation-work-progress')).toBeVisible();
    const explorer = screen.getByTestId('explorer');
    expect(explorer).not.toBeVisible();
    fireEvent.click(screen.getByText('conversation.workspace.title'));
    expect(screen.getByTestId('explorer')).toBe(explorer);
    expect(explorer).toBeVisible();
    expect(screen.queryByTestId('conversation-work-progress')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('conversation.workProgress.title'));
    expect(screen.getByTestId('conversation-work-progress')).toBeVisible();
  });

  it('renders the localized task summary instead of the ComfyUI function name', () => {
    setCurrentConversation('c1');
    publishWorkProgress(
      'c1',
      projectWorkProgress([tool('generate', 'aionui_h3_generate_video', 'running')], {
        ...runtime,
        isProcessing: true,
      })
    );

    render(<ConversationWorkProgress conversationId='c1' />);

    expect(screen.getByText('conversation.workProgress.summaries.generateVideo')).toBeInTheDocument();
    expect(screen.queryByText('aionui_h3_generate_video')).not.toBeInTheDocument();
  });

  it('renders plan entries as the checklist without an extra Plan row', () => {
    setCurrentConversation('c1');
    publishWorkProgress(
      'c1',
      projectWorkProgress(
        [
          plan([
            { content: '检查本地环境', status: 'completed' },
            { content: '生成视频', status: 'in_progress' },
          ]),
        ],
        { ...runtime, isProcessing: true }
      )
    );

    render(<ConversationWorkProgress conversationId='c1' />);

    expect(screen.getByText('检查本地环境')).toBeInTheDocument();
    expect(screen.getByText('生成视频')).toBeInTheDocument();
    expect(screen.queryByText('conversation.workProgress.kinds.plan')).not.toBeInTheDocument();
  });

  it('updates completed progress live and keeps status labels out of the ordinary checklist text', () => {
    const steps = [
      { content: '检测设备', status: 'completed' as const },
      { content: '下载模型', status: 'in_progress' as const },
      { content: '验证生成', status: 'pending' as const },
    ];
    publishWorkProgress('c1', projectWorkProgress([plan(steps)], { ...runtime, isProcessing: true }));
    render(<ConversationWorkProgress conversationId='c1' />);

    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '1');
    expect(progress).toHaveAttribute('aria-valuemax', '3');
    expect(screen.getByRole('status')).toHaveTextContent('conversation.workProgress.statuses.running');
    expect(screen.getByRole('list')).toHaveTextContent('下载模型');
    expect(screen.getByRole('list')).not.toHaveTextContent('conversation.workProgress.statuses.completed');
    expect(screen.getByRole('img', { name: 'conversation.workProgress.statuses.completed' })).toBeInTheDocument();
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent('下载模型');

    act(() =>
      publishWorkProgress(
        'c1',
        projectWorkProgress([plan(steps.map(({ content }) => ({ content, status: 'completed' })))], runtime)
      )
    );
    expect(progress).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('status')).toHaveTextContent('conversation.workProgress.statuses.completed');
    expect(document.querySelector('[aria-current="step"]')).toBeNull();
  });

  it('shows waiting and error explanations while keeping recovery tied to the existing conversation', () => {
    publishWorkProgress('c1', {
      tasks: [{ id: 'failed-step', title: '校验模型', kind: 'task', status: 'failed', detail: 'SHA-256 mismatch' }],
      isProcessing: false,
      pendingConfirmations: 1,
    });
    render(<ConversationWorkProgress conversationId='c1' />);

    expect(screen.getByRole('status')).toHaveTextContent('conversation.workProgress.statuses.waiting');
    expect(screen.getByText('conversation.workProgress.waitingHint')).toBeInTheDocument();
    expect(screen.getByRole('list')).toHaveTextContent('conversation.workProgress.statuses.failed');
    expect(screen.getByText('SHA-256 mismatch')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'conversation.workProgress.prepareResume' }));
    expect(mocks.prefill).toHaveBeenCalledWith('c1', 'conversation.workProgress.resumePrompt');
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it('keeps the progress entry available with no plan and isolates conversation switches', () => {
    setCurrentProject('p1');
    setCurrentConversation('c1');
    publishWorkProgress('c1', projectWorkProgress([], runtime, [operation()]));
    render(<ProjectPanelHost widthPx={320} collapsed={false} />);
    expect(screen.getByText('Qwen-Edit')).toBeInTheDocument();
    act(() => setCurrentConversation('c2'));
    expect(screen.queryByText('Qwen-Edit')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('conversation.workProgress.title'));
    expect(screen.getByText('conversation.workProgress.empty')).toBeInTheDocument();
  });

  it('displays a persisted preparation and ignores preparation records from another conversation', async () => {
    setCurrentConversation('c1');
    mocks.activity.mockResolvedValue({
      operations: [],
      jobs: [],
      preparations: [
        { requestId: 'r1', conversationId: 'c1', family: 'qwen-edit', status: 'detecting' },
        { requestId: 'r2', conversationId: 'other', family: 'private-family', status: 'failed' },
      ],
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MessageListProvider value={[]}>
          <WorkProgressBridge conversationId='c1' />
        </MessageListProvider>
        <ConversationWorkProgress conversationId='c1' />
      </SWRConfig>
    );
    await waitFor(() => expect(screen.getByText('conversation.workProgress.detecting')).toBeInTheDocument());
    expect(screen.getByText('qwen-edit')).toBeInTheDocument();
    expect(screen.queryByText('private-family')).not.toBeInTheDocument();
  });
});
