import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import type { ComfyGenerationJob, ComfyOperation } from '@/common/chat/document/creation/comfy';

const mocks = vi.hoisted(() => ({
  activity: vi.fn(),
  authorize: vi.fn(),
  prefill: vi.fn(),
  runtime: { isProcessing: false, hydrated: true, view: { pendingConfirmations: 0 } },
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
  resetWorkProgressForTest();
  resetCurrentProjectForTest();
  resetCurrentConversationForTest();
});

describe('unified work projection', () => {
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
