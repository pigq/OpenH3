import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RendererErrorBoundary from '@/renderer/components/RendererErrorBoundary';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function BrokenRoute(): React.ReactElement {
  throw new TypeError('route render failed');
}

afterEach(() => vi.restoreAllMocks());

it('shows a reload fallback instead of leaving the application root blank after a route render exception', () => {
  const reload = vi.fn();
  const report = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  render(
    <RendererErrorBoundary onReload={reload}>
      <BrokenRoute />
    </RendererErrorBoundary>
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('common.rendererRecovery.title')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'common.reload' }));
  expect(reload).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith('[OpenH3] Renderer route error', expect.any(TypeError), expect.any(Object));
});
