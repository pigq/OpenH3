import React, { useEffect, useState } from 'react';
import { Button, Image } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';

/** Compact, uncropped media inside chat; deliberate inspection uses the existing image viewer. */
export default function ConversationImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => setVisible(false), [src]);
  return (
    <>
      <Button
        type='text'
        aria-label={`${t('preview.preview')} ${alt}`.trim()}
        aria-haspopup='dialog'
        title={t('preview.preview')}
        onClick={() => setVisible(true)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          display: 'inline-flex',
          alignItems: 'flex-start',
          verticalAlign: 'top',
          width: 'auto',
          height: 'auto',
          maxWidth: 'min(100%, 640px)',
          minWidth: 0,
          padding: 0,
          border: 0,
          borderRadius: 8,
          background: 'transparent',
          lineHeight: 0,
          cursor: 'zoom-in',
          outline: focused ? '2px solid var(--primary)' : undefined,
          outlineOffset: 3,
        }}
      >
        <img
          src={src}
          alt={alt}
          className={className}
          loading='lazy'
          style={{
            display: 'block',
            minWidth: 0,
            width: 'auto',
            height: 'auto',
            maxWidth: '100%',
            maxHeight: 'min(420px, 52dvh)',
            objectFit: 'contain',
            borderRadius: 8,
          }}
        />
      </Button>
      {visible && (
        <Image.Preview
          src={src}
          visible
          imgAttributes={{ alt }}
          onVisibleChange={setVisible}
          actionsLayout={['zoomIn', 'zoomOut', 'originalSize', 'rotateLeft', 'rotateRight']}
        />
      )}
    </>
  );
}
