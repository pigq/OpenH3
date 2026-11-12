import React, { useState } from 'react';
import { Button, Dropdown, Menu, Modal } from '@arco-design/web-react';
import { Check, Down, Magic, Plus, SettingConfig } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { CLOUD_IMAGE_PRESETS } from '@/common/chat/document/creation/cloudModels';
import CloudModelSetup from './CloudModelSetup';
import CloudVideoSetup from './CloudVideoSetup';
import type {
  CreationKind,
  CreationModel,
  CreationSelection,
  CreationSource,
} from '@/common/chat/document/creation/creation';
import styles from './creation.module.css';

type Props = {
  selection: CreationSelection;
  models: CreationModel[];
  model: CreationModel;
  onChange: React.Dispatch<React.SetStateAction<CreationSelection>>;
  onManageLocal: (model: CreationModel) => void;
  inventoryError?: string;
};

export default function CreationControls({ selection, models, model, onChange, onManageLocal, inventoryError }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState<CreationModel>();
  const empty = !models.length;
  const emptyLocal = empty && selection.source === 'local' && model.state === 'not-installed';
  const manage = () => {
    setOpen(false);
    if (selection.source === 'local') onManageLocal(model);
    else setConfiguring(model);
  };
  const Setup = configuring?.kind === 'video' ? CloudVideoSetup : CloudModelSetup;
  const modelName = (item: CreationModel) =>
    item.name ||
    t(
      emptyLocal
        ? 'guid.creation.noLocalModels'
        : `guid.creation.${item.source}${item.kind === 'image' ? 'Image' : 'Video'}`
    );
  const providerName = (item: CreationModel) =>
    item.provider?.name ?? CLOUD_IMAGE_PRESETS.find((preset) => preset.id === item.presetId)?.name;
  return (
    <>
      <div className={styles.segment} role='group' aria-label={t('guid.creation.kind')}>
        {(['image', 'video'] as CreationKind[]).map((kind) => (
          <Button
            key={kind}
            type='text'
            size='small'
            aria-pressed={selection.kind === kind}
            className={selection.kind === kind ? styles.selected : undefined}
            onClick={() => onChange((previous) => ({ ...previous, kind }))}
          >
            {t(`guid.templateFilters.${kind}`)}
          </Button>
        ))}
      </div>
      <div className={styles.segment} role='group' aria-label={t('guid.creation.source')}>
        {(['local', 'cloud'] as CreationSource[]).map((source) => (
          <Button
            key={source}
            type='text'
            size='small'
            aria-pressed={selection.source === source}
            className={selection.source === source ? styles.selected : undefined}
            onClick={() => onChange((previous) => ({ ...previous, source }))}
          >
            {t(`guid.creation.${source}`)}
          </Button>
        ))}
      </div>
      <Dropdown
        trigger='click'
        popupVisible={open}
        onVisibleChange={setOpen}
        position='bl'
        triggerProps={{ autoAlignPopupWidth: false, popupStyle: { maxWidth: 'calc(100vw - 24px)' } }}
        droplist={
          <Menu className={styles.menu} selectedKeys={empty ? [] : [model.id]}>
            {selection.source === 'local' && inventoryError && (
              <Menu.Item
                key='inventory-diagnostics'
                onClick={() => {
                  setOpen(false);
                  Modal.info({
                    title: t('guid.creation.inventoryIncomplete'),
                    content: (
                      <div>
                        <p>{t('guid.creation.inventoryIncompleteHint')}</p>
                        <pre className='whitespace-pre-wrap break-all text-12px select-text'>{inventoryError}</pre>
                      </div>
                    ),
                  });
                }}
              >
                {t('guid.creation.inventoryIncomplete')}
              </Menu.Item>
            )}
            {empty && (
              <Menu.Item key='empty' disabled aria-disabled='true'>
                {t(emptyLocal ? 'guid.creation.noLocalModelsHint' : `guid.creation.states.${model.state}`)}
              </Menu.Item>
            )}
            {models.map((item) => (
              <Menu.Item
                key={item.id}
                disabled={item.source === 'cloud' && (item.state === 'unsupported' || item.state === 'unavailable')}
                onClick={() => {
                  if (item.source === 'cloud' && !item.available) {
                    setOpen(false);
                    setConfiguring(item);
                    return;
                  }
                  onChange((previous) => ({
                    ...previous,
                    modelIds: { ...previous.modelIds, [`${selection.source}-${selection.kind}`]: item.id },
                  }));
                  setOpen(false);
                  if (item.source === 'local' && !item.profileId && !item.available) onManageLocal(item);
                }}
              >
                <span className={styles.menuCheck} aria-hidden='true'>
                  {item.id === model.id && <Check theme='outline' size='14' />}
                </span>
                <span
                  className={styles.menuModel}
                  title={[modelName(item), providerName(item)].filter(Boolean).join(' · ')}
                >
                  <span className={styles.modelName}>{modelName(item)}</span>
                  {providerName(item) && <span className={styles.providerName}>{providerName(item)}</span>}
                </span>
                {item.source === 'cloud' && (
                  <span className={styles.state}>{t(`guid.creation.states.${item.state}`)}</span>
                )}
              </Menu.Item>
            ))}
            <Menu.Item key='manage' className={styles.manageItem} onClick={manage}>
              <SettingConfig theme='outline' size='14' />
              {t(selection.source === 'local' ? 'guid.creation.manageLocal' : 'guid.creation.configureCloud')}
            </Menu.Item>
            {selection.source === 'cloud' && selection.kind === 'video' && model.id.startsWith('cloud-video:') && (
              <Menu.Item
                key='add-cloud'
                onClick={() => {
                  setOpen(false);
                  setConfiguring({
                    id: 'preset::cloud-video',
                    name: 'MiniMax H3',
                    kind: 'video',
                    source: 'cloud',
                    state: 'not-configured',
                    available: false,
                  });
                }}
              >
                <Plus theme='outline' size='14' />
                {t('guid.creation.addCloud')}
              </Menu.Item>
            )}
          </Menu>
        }
      >
        <Button
          type='text'
          size='small'
          className={styles.modelTrigger}
          aria-label={t('guid.creation.model')}
          data-testid='creation-model-selector'
          aria-expanded={open}
          title={[modelName(model), providerName(model)].filter(Boolean).join(' · ')}
        >
          <span className={styles.modelContent}>
            <Magic theme='outline' size='14' />
            <span className={styles.modelName}>{modelName(model)}</span>
            {!emptyLocal && (model.source === 'cloud' || !model.profileId) && (
              <span className={styles.triggerState}>{t(`guid.creation.states.${model.state}`)}</span>
            )}
            <Down theme='outline' size='14' strokeWidth={4} className={open ? styles.arrowOpen : styles.arrow} />
          </span>
        </Button>
      </Dropdown>
      {configuring && (
        <Setup
          model={configuring}
          onClose={() => setConfiguring(undefined)}
          onSaved={(id) => {
            onChange((previous) => ({
              ...previous,
              modelIds: { ...previous.modelIds, [`cloud-${configuring.kind}`]: id },
            }));
            setConfiguring(undefined);
          }}
        />
      )}
    </>
  );
}
