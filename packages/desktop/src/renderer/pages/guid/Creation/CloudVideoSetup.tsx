import React, { useEffect, useState } from 'react';
import { Alert, Form, Input, Message, Modal, Select } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { mutate } from 'swr';
import { cloudVideoApi } from '@/common/chat/document/creation/cloudVideoApi';
import {
  H3_CLOUD_BASE_URL,
  H3_CLOUD_LORA_PATH,
  type PublicVideoConnection,
} from '@/common/chat/document/creation/cloudVideo';
import type { CreationModel } from '@/common/chat/document/creation/creation';

export default function CloudVideoSetup({
  model,
  onClose,
  onSaved,
}: {
  model: CreationModel;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [existing, setExisting] = useState<PublicVideoConnection>();
  const [loading, setLoading] = useState(model.id.startsWith('cloud-video:'));
  const [protocol, setProtocol] = useState<'vllm-h3' | 'openai-video'>('vllm-h3');
  const [name, setName] = useState('MiniMax H3');
  const [baseUrl, setBaseUrl] = useState(H3_CLOUD_BASE_URL);
  const [modelName, setModelName] = useState('');
  const [loraPath, setLoraPath] = useState(H3_CLOUD_LORA_PATH);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, contextHolder] = Message.useMessage();
  useEffect(() => {
    let alive = true;
    if (!model.id.startsWith('cloud-video:')) return;
    void cloudVideoApi
      .connections()
      .then((connections) => {
        const item = connections.find((connection) => `cloud-video:${connection.id}` === model.id);
        if (!alive) return;
        if (!item) throw new Error('CLOUD_VIDEO_CONNECTION_MISSING');
        setExisting(item);
        setProtocol(item.protocol);
        setName(item.name);
        setBaseUrl(item.baseUrl);
        setModelName(item.model);
        setLoraPath(item.loraPath ?? H3_CLOUD_LORA_PATH);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setError(t('guid.creation.cloudSetup.saveFailed'));
      });
    return () => {
      alive = false;
    };
  }, [model.id, t]);
  const save = async () => {
    setSaving(true);
    try {
      const saved = await cloudVideoApi.save({
        id: existing?.id,
        name: name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        model: modelName.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(protocol === 'vllm-h3' ? { loraPath } : {}),
      });
      await mutate('creation.cloud-video-connections');
      setApiKey('');
      onSaved(`cloud-video:${saved.id}`);
    } catch {
      message.error(t('guid.creation.cloudVideoSetup.invalid'));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      visible
      title={t('guid.creation.configureCloud')}
      onCancel={onClose}
      onOk={() => void save()}
      confirmLoading={saving}
      okButtonProps={{ disabled: loading || Boolean(error) }}
      okText={t('common.save')}
      style={{ width: 600, maxWidth: 'calc(100vw - 32px)' }}
    >
      {contextHolder}
      <Alert type='info' content={t('guid.creation.cloudVideoSetup.hint')} className='mb-16px' />
      {error && <Alert type='error' content={error} />}
      <Form layout='vertical'>
        <Form.Item label={t('guid.creation.cloudVideoSetup.protocol')}>
          <Select
            aria-label={t('guid.creation.cloudVideoSetup.protocol')}
            value={protocol}
            onChange={(value: 'vllm-h3' | 'openai-video') => {
              setProtocol(value);
              setApiKey('');
            }}
            options={[
              { value: 'vllm-h3', label: 'vLLM-Omni · MiniMax H3' },
              { value: 'openai-video', label: 'OpenAI Videos' },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('guid.creation.cloudSetup.provider')}>
          <Input aria-label={t('guid.creation.cloudSetup.provider')} value={name} onChange={setName} />
        </Form.Item>
        <Form.Item label={t('guid.creation.cloudSetup.baseUrl')}>
          <Input aria-label={t('guid.creation.cloudSetup.baseUrl')} value={baseUrl} onChange={setBaseUrl} />
        </Form.Item>
        <Form.Item label={t('guid.creation.model')}>
          <Input
            aria-label={t('guid.creation.model')}
            value={modelName}
            onChange={setModelName}
            placeholder={t('guid.creation.cloudVideoSetup.modelHint')}
          />
        </Form.Item>
        <Form.Item label={t('settings.apiKey')}>
          <Input.Password
            aria-label={t('settings.apiKey')}
            value={apiKey}
            onChange={setApiKey}
            autoComplete='new-password'
            placeholder={t('guid.creation.cloudVideoSetup.keyHint')}
          />
        </Form.Item>
        {protocol === 'vllm-h3' && (
          <Form.Item label={t('guid.creation.cloudVideoSetup.loraPath')}>
            <Input aria-label={t('guid.creation.cloudVideoSetup.loraPath')} value={loraPath} onChange={setLoraPath} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
