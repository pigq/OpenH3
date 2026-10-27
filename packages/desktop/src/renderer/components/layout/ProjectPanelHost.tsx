/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layout-level Project Panel host (stage3 FULL / P1–P4). This is the project's
 * right-side panel host: it owns the column's width, border and lifecycle, and
 * mounts a self-contained project component inside. The titlebar owns the desktop
 * collapse control. For this round
 * the hosted component is the Explorer ({@link ExplorerContainer}); the host is
 * named generically (not `ProjectExplorerColumn`) so future project-scoped
 * components (source-control, kanban, …) can mount through the same seam without
 * re-architecting the host — no plugin framework is introduced this round.
 *
 * Seam: the host passes only `projectId` down; the component self-manages its
 * content (data, tree, actions). Host chrome (the drag handle) is the host's
 * concern, never the component's.
 *
 * Rendered as a sibling of the route `<Outlet>`, above the per-conversation
 * subtree, so switching conversations within the same project does NOT remount it
 * — WS subscriptions, tree and preview stay live (no teardown, no flicker).
 * Collapsing shrinks the column to width 0 (kept mounted) rather than
 * unmounting, so collapse/expand also preserves state. `data-mount-id` (once per
 * mount) is the live-test proof it is not remounted across switches or collapse.
 */

import React, { useEffect, useRef, useState } from 'react';

import { ExplorerContainer } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { useCurrentConversation } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { useWorkProgress } from '@/renderer/pages/conversation/PlanBar/workProgress';
import ConversationWorkProgress from '@/renderer/pages/conversation/PlanBar/ConversationWorkProgress';
import WorkProgressTabs from '@/renderer/pages/conversation/PlanBar/WorkProgressTabs';

/** Shares the existing project column; the Explorer remains mounted while progress is visible. */
export function ProjectPanelContent({ projectId }: { projectId: string }) {
  const conversationId = useCurrentConversation();
  const work = useWorkProgress(conversationId);
  const workIdentity = work.tasks.map((task) => task.id).join('\n');
  const [progressActive, setProgressActive] = useState(false);
  useEffect(() => {
    setProgressActive(Boolean(workIdentity));
  }, [conversationId, workIdentity]);
  return (
    <div className='h-full flex flex-col min-h-0' data-project-panel-content>
      {conversationId && (
        <div className='px-12px py-6px border-b border-solid border-3 shrink-0'>
          <WorkProgressTabs workspaceAvailable progressActive={progressActive} onChange={setProgressActive} />
        </div>
      )}
      <div className='flex-1 min-h-0' style={{ display: progressActive ? 'none' : undefined }}>
        <ExplorerContainer projectId={projectId} />
      </div>
      {progressActive && conversationId && (
        <div className='flex-1 min-h-0'>
          <ConversationWorkProgress conversationId={conversationId} />
        </div>
      )}
    </div>
  );
}

export type ProjectPanelHostProps = {
  /** Rendered width in px (clamped by Layout against the chat+preview reserve). */
  widthPx: number;
  /** Collapsed → width 0, component kept mounted (no remount). */
  collapsed: boolean;
  /** Left-edge resize handle from Layout's `useResizableSplit`. */
  dragHandle?: React.ReactNode;
};

export const ProjectPanelHost: React.FC<ProjectPanelHostProps> = ({ widthPx, collapsed, dragHandle }) => {
  const projectId = useCurrentProject();
  const mountIdRef = useRef<string>('');
  if (mountIdRef.current === '') mountIdRef.current = `pec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // No active project (no-project conversation / non-chat route) → no host.
  if (!projectId) return null;

  return (
    <div
      data-project-panel-host
      data-explorer-column
      data-mount-id={mountIdRef.current}
      data-collapsed={collapsed ? 'true' : 'false'}
      className='!bg-1 h-full flex-shrink-0 overflow-hidden relative'
      style={{
        width: collapsed ? '0px' : `${widthPx}px`,
        borderLeft: collapsed ? 'none' : '1px solid var(--bg-3)',
      }}
    >
      {!collapsed && dragHandle}
      {/* Hosted project component (this round: Explorer). Seam = projectId only. */}
      <ProjectPanelContent projectId={projectId} />
    </div>
  );
};
