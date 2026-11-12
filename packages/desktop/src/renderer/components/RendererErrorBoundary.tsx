import React, { type ErrorInfo, type ReactNode } from 'react';
import { Button, Result } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

type State = { failed: boolean };
type Props = { children: ReactNode; onReload?: () => void };

function RecoveryView({ onReload }: { onReload: () => void }) {
  const { t } = useTranslation();
  return (
    <main role='alert' className='min-h-screen bg-bg-1 flex items-center justify-center px-24px'>
      <Result
        status='error'
        title={t('common.rendererRecovery.title')}
        subTitle={t('common.rendererRecovery.description')}
        extra={
          <Button type='primary' onClick={onReload}>
            {t('common.reload')}
          </Button>
        }
      />
    </main>
  );
}

export default class RendererErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[OpenH3] Renderer route error', error, info);
  }

  render(): ReactNode {
    if (this.state.failed) return <RecoveryView onReload={this.props.onReload ?? (() => window.location.reload())} />;
    return this.props.children;
  }
}
