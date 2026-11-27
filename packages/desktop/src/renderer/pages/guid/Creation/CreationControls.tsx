import React, { useState } from 'react';
import { Button, Dropdown, Menu, Message, Modal } from '@arco-design/web-react';
import { Check, Down, Magic, Plus, SettingConfig } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { CLOUD_IMAGE_PRESETS } from '@/common/chat/document/creation/cloudModels';
import type { useAccountMedia } from './useAccountMedia';
import { accountMediaId } from '@/common/chat/document/creation/accountMedia';
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
  accountMedia?: ReturnType<typeof useAccountMedia>;
};

export default function CreationControls({
  selection,
  models,
  model,
  onChange,
  onManageLocal,
  inventoryError,
  accountMedia,
}: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [configuring, setConfiguring] = useState<CreationModel>();
  const [saving, setSaving] = useState(false);
  const [message, contextHolder] = Message.useMessage();
  const empty = !models.length;
  const defaultRef = accountMedia?.defaultModel;
  const defaultId = defaultRef && accountMediaId(defaultRef.accountId, defaultRef.modelId);
  const saveChoice = async (id: string, done: () => void) => {
    if (saving) return;
    if (!accountMedia) {
      done();
      return;
    }
    setSaving(true);
    try {
      await accountMedia.setDefault(selection.kind, id);
      done();
    } catch {
      message.error(t('guid.creation.cloudSetup.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
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
    item.capabilities?.map((capability) => t(`guid.comfy.workflows.tasks.${capability}`)).join(' · ') ??
    item.provider?.name ??
    CLOUD_IMAGE_PRESETS.find((preset) => preset.id === item.presetId)?.name;
  const renderModel = (item: CreationModel) => (
    <Menu.Item
      key={item.id}
      disabled={saving || (item.source === 'cloud' && (item.state === 'unsupported' || item.state === 'unavailable'))}
      onClick={() => {
        if (item.source === 'cloud' && !item.available) {
          setOpen(false);
          setConfiguring(item);
          return;
        }
        void saveChoice(item.id, () => {
          onChange((previous) => ({
            ...previous,
            modelIds: { ...previous.modelIds, [`${selection.source}-${selection.kind}`]: item.id },
          }));
          setOpen(false);
          if (item.source === 'local' && !item.profileId && !item.available) onManageLocal(item);
        });
      }}
    >
      <span className={styles.menuCheck} aria-hidden='true'>
        {item.id === model.id && <Check theme='outline' size='14' />}
      </span>
      <span className={styles.menuModel} title={[modelName(item), providerName(item)].filter(Boolean).join(' · ')}>
        <span className={styles.modelName}>{modelName(item)}</span>
        {providerName(item) && <span className={styles.providerName}>{providerName(item)}</span>}
      </span>
      {item.source === 'cloud' && (
        <span className={styles.state}>
          {item.id === defaultId ? t('guid.creation.chatDefault') : t(`guid.creation.states.${item.state}`)}
        </span>
      )}
    </Menu.Item>
  );
  return (
    <>
      {contextHolder}
      <div className={styles.segment} role='group' aria-label={t('guid.creation.kind')}>
        {(['image', 'video'] as CreationKind[]).map((kind) => (
          <Button
            key={kind}
            type='text'
            size='small'
            aria-pressed={selection.kind === kind}
            className={selection.kind === kind ? styles.selected : undefined}
            onClick={() =>
              onChange((previous) => {
                const sources = { ...previous.sources, [previous.kind]: previous.source };
                return { ...previous, kind, sources, source: sources[kind] ?? previous.source };
              })
            }
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
            onClick={() =>
              onChange((previous) => ({
                ...previous,
                source,
                sources: { ...previous.sources, [previous.kind]: source },
              }))
            }
          >
            {t(`guid.creation.${source}`)}
          </Button>
        ))}
      </div>
      <Dropdown
        trigger='click'
        popupVisible={open}
        onVisibleChange={(visible) => {
          setOpen(visible);
          if (visible && selection.source === 'cloud') accountMedia?.refresh(false);
        }}
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
            {accountMedia?.catalogState && (
              <Menu.ItemGroup key='account' title={t('settings.cloudAccount.title')}>
                {accountMedia.catalogState !== 'available' && accountMedia.catalogState !== 'unavailable' ? (
                  <Menu.Item key='account-status' disabled>
                    {t(
                      accountMedia.catalogState === 'empty'
                        ? 'guid.creation.noAccountModels'
                        : 'guid.creation.states.checking'
                    )}
                  </Menu.Item>
                ) : null}
                {models.filter((item) => item.id.startsWith('account-media:')).map(renderModel)}
                {accountMedia.catalogState !== 'checking' && (
                  <Menu.Item key='refresh-account' onClick={() => accountMedia.refresh()}>
                    {t(
                      accountMedia.catalogState === 'unavailable'
                        ? 'guid.creation.retryAccountModels'
                        : 'settings.cloudAccount.refreshCatalog'
                    )}
                  </Menu.Item>
                )}
              </Menu.ItemGroup>
            )}
            {models.filter((item) => !item.id.startsWith('account-media:')).map(renderModel)}
            {defaultRef && (
              <Menu.Item
                key='clear-chat-default'
                disabled={saving}
                onClick={() => {
                  void saveChoice('', () => setOpen(false));
                }}
              >
                {t('guid.creation.clearChatDefault')}
              </Menu.Item>
            )}
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
            void saveChoice(id, () => {
              onChange((previous) => ({
                ...previous,
                modelIds: { ...previous.modelIds, [`cloud-${configuring.kind}`]: id },
              }));
              setConfiguring(undefined);
            });
          }}
        />
      )}
    </>
  );
}
