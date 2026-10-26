/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createElement, useSyncExternalStore } from 'react';
import { Modal } from '@arco-design/web-react';
import type { UpdateNotificationState } from './updateNotificationState';

export const UPDATE_READY_STATE_EVENT = 'openh3-update-ready-state-changed';
export const LEGACY_UPDATE_READY_STATE_EVENT = 'aionui-update-ready-state-changed';

export type UpdateReadyState = {
  ready: boolean;
  version: string;
  filePath?: string;
  preparing?: boolean;
};

let currentUpdateReadyState: UpdateReadyState = {
  ready: false,
  version: '',
};

export const getUpdateReadyState = () => currentUpdateReadyState;

export const setUpdateReadyState = (state: UpdateReadyState) => {
  currentUpdateReadyState = state;
  window.dispatchEvent(new CustomEvent<UpdateReadyState>(UPDATE_READY_STATE_EVENT, { detail: state }));
  window.dispatchEvent(new CustomEvent<UpdateReadyState>(LEGACY_UPDATE_READY_STATE_EVENT, { detail: state }));
};

export const subscribeUpdateReadyState = (listener: (state: UpdateReadyState) => void) => {
  const handledStates = new WeakSet<object>();
  const handler = (evt: Event) => {
    const state = (evt as CustomEvent<UpdateReadyState>).detail;
    if (state && typeof state === 'object') {
      if (handledStates.has(state)) return;
      handledStates.add(state);
    }
    listener(state);
  };
  window.addEventListener(UPDATE_READY_STATE_EVENT, handler);
  window.addEventListener(LEGACY_UPDATE_READY_STATE_EVENT, handler);
  return () => {
    window.removeEventListener(UPDATE_READY_STATE_EVENT, handler);
    window.removeEventListener(LEGACY_UPDATE_READY_STATE_EVENT, handler);
  };
};

const sidebarListeners = new Set<() => void>();
let sidebarState: UpdateNotificationState | null = null;
export const SIDEBAR_UPDATE_ACTION_EVENT = 'openh3-sidebar-update-action';
export const getSidebarUpdateState = () => sidebarState;
export const setSidebarUpdateState = (state: UpdateNotificationState | null) => {
  sidebarState = state;
  sidebarListeners.forEach((listener) => listener());
};
export const subscribeSidebarUpdateState = (listener: () => void) => {
  sidebarListeners.add(listener);
  return () => {
    sidebarListeners.delete(listener);
  };
};
export const requestSidebarUpdateAction = () => window.dispatchEvent(new Event(SIDEBAR_UPDATE_ACTION_EVENT));

type InstallConfirmation = {
  labels: { title: string; content: string; okText: string; cancelText: string };
  install: () => void;
};
let confirmation: InstallConfirmation | null = null;
const confirmationListeners = new Set<() => void>();
const notifyConfirmation = () => confirmationListeners.forEach((listener) => listener());
export const dismissUpdateInstallConfirmation = () => {
  confirmation = null;
  notifyConfirmation();
};
/** All install entry points share one confirmation rendered within the app tree. */
export const confirmUpdateInstall = (labels: InstallConfirmation['labels'], install: () => void) => {
  if (confirmation) return;
  confirmation = { labels, install };
  notifyConfirmation();
};
const subscribeConfirmation = (listener: () => void) => {
  confirmationListeners.add(listener);
  return () => {
    confirmationListeners.delete(listener);
  };
};
export const UpdateInstallConfirmation = () => {
  const current = useSyncExternalStore(subscribeConfirmation, () => confirmation);
  if (!current) return null;
  return createElement(
    Modal,
    {
      visible: true,
      title: current.labels.title,
      okText: current.labels.okText,
      cancelText: current.labels.cancelText,
      onOk: () => {
        dismissUpdateInstallConfirmation();
        current.install();
      },
      onCancel: dismissUpdateInstallConfirmation,
    },
    current.labels.content
  );
};
