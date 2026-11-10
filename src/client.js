window.__ModuleLoader__.load({
  id: 'dingtalk-dsh',
  factory: (require) => {
    const { createElement: h, useEffect, useState, useSyncExternalStore } = require('react');
    const {
      Button, SettingsForm, SettingsFormModel, SettingsSecretField, SettingsValueField,
      Switch, settingsNumberField, settingsTextField,
    } = require('@deepseek-ai/dsh-client-ui-primitives');
    const secretRef = 'DINGTALK_DSH_CLIENT_SECRET';

    function DingTalkOrigin({ matched }) {
      let data;
      try { data = JSON.parse(matched).data; } catch { return null; }
      if (!data || typeof data !== 'object') return null;
      const group = data.conversationType === '2';
      const title = group && typeof data.conversationTitle === 'string' ? data.conversationTitle.trim() : '';
      const sender = typeof data.senderNick === 'string' ? data.senderNick.trim() : '';
      const label = [group ? '钉钉群聊' : '钉钉单聊', title, sender || '钉钉用户'].filter(Boolean).join(' · ');
      return h('details', { style: { alignSelf: 'flex-end', fontSize: '12px', maxWidth: 'min(100%, 32rem)' } },
        h('summary', { style: { cursor: 'pointer', opacity: 0.72, overflowWrap: 'anywhere' } }, label),
        h('pre', {
          'aria-label': '钉钉消息元数据',
          style: { margin: '4px 0', padding: '6px 8px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '16rem', overflow: 'auto' },
        }, matched),
      );
    }

    const fields = [
      ['clientId', 'Client ID（AppKey）', '从钉钉开放平台的应用凭证页面复制。'],
      ['dataDir', '数据目录', '用于保存桥接队列和会话映射。留空使用桌面模式的默认目录。'],
      ['workspace', '工作区', '钉钉会话显示在此工作区。留空使用默认工作区。'],
      ['runTimeoutSeconds', '任务超时（秒）', '允许 10 至 3600 秒。首次配置可留空，默认为 300 秒。'],
    ];
    const labels = {
      unavailable: '正在等待桌面宿主提供桥接配置。',
      readOnly: '当前配置只读。',
      saveFailed: '保存失败。可放弃修改后，按当前配置重试。',
      save: '保存配置',
      saving: '正在保存…',
    };

    function apply(ctx) {
      const form = ctx.configForms.get('dingtalk-bridge');
      const timeout = settingsNumberField('runTimeoutSeconds');
      const model = new SettingsFormModel(form, fields.map(([key]) => {
        if (key !== 'runTimeoutSeconds') return settingsTextField(key);
        return {
          ...timeout,
          parse: (text) => {
            const parsed = timeout.parse(text);
            if (parsed?.kind === 'set' && (!Number.isInteger(parsed.value) || parsed.value < 10 || parsed.value > 3600)) {
              return undefined;
            }
            return parsed;
          },
        };
      }), [{
        field: 'clientSecret',
        write: async (value) => (await ctx.remote.credentials.set(secretRef, value)).ok,
      }]);
      const store = model.bind(() => ({
        ...model.shell(),
        config: form.getSnapshot(),
        fields: fields.map(([key]) => model.field(key)),
        secretDraft: model.field('clientSecret').text,
      }));
      const actions = model.actions();
      ctx.effect(() => () => model.dispose());

      function BridgeSettings() {
        const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
        const [switching, setSwitching] = useState(false);
        const [error, setError] = useState('');
        const [credential, setCredential] = useState(null);
        const { value, revision } = state.config;
        const enabled = value?.enabled === true;
        const busy = switching || state.saving;

        useEffect(() => {
          let request = 0;
          let closed = false;
          async function refresh() {
            const current = ++request;
            let info = { failed: true };
            try {
              const result = await ctx.remote.credentials.describe([secretRef]);
              if (result.ok) info = result.value[secretRef] ?? { configured: false, writable: true };
            } catch {
              // 只显示固定状态，避免回显宿主返回的内容。
            }
            if (!closed && current === request) setCredential(info);
          }
          const off = ctx.remote.$on('credentials/reference-updated', (ref) => {
            if (ref === secretRef) void refresh();
          });
          void refresh();
          return () => {
            closed = true;
            off();
          };
        }, []);

        async function toggle(field, next) {
          setError('');
          if (field === 'enabled' && next && (!value?.clientId?.trim() || !credential?.configured)) {
            setError('请先填写并保存钉钉应用的 Client ID 和 Client Secret。');
            return;
          }
          setSwitching(true);
          try {
            const saved = await form.mutate([{ op: 'set', path: [field], value: next }], revision);
            if (!saved) setError('无法保存开关设置，请重试。');
          } catch {
            setError('无法保存开关设置，请重试。');
          } finally {
            setSwitching(false);
          }
        }

        function renderField([key, label, hint], index) {
          return h(SettingsValueField, {
            key,
            id: `dingtalk-bridge-${key}`,
            label,
            hint,
            numeric: key === 'runTimeoutSeconds',
            invalidLabel: '请输入 10 至 3600 之间的整数。',
            overriddenLabel: '已配置',
            resetLabel: '恢复默认',
            disabled: !state.writable || busy || (key === 'clientId' && enabled),
            ...state.fields[index],
            onEdit: (text) => { setError(''); actions.edit(key, text); },
            onReset: () => actions.resetField(key),
          });
        }

        function renderSwitch(field, label, hint) {
          return h('div', {
            style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', marginBottom: '20px' },
          },
          h('div', null,
            h('div', { style: { fontWeight: 600 } }, label),
            h('p', { style: { margin: '4px 0 0' } }, state.dirty
              ? '保存或放弃修改后即可切换。'
              : hint),
          ),
          h(Switch, {
            checked: value?.[field] === true,
            disabled: !state.writable || state.dirty || busy,
            label,
            onChange: (next) => toggle(field, next),
          }));
        }

        return h('section', { 'aria-label': '钉钉桥接配置', 'aria-busy': busy },
          state.available && renderSwitch('enabled', '启用钉钉桥接', '关闭桥接会停止接收钉钉消息，已建立的会话和映射会保留。'),
          state.available && renderSwitch('reportProgress', '在钉钉发送进度', '发送开始处理提示和 DSH 任务清单的完成数。'),
          error && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error),
          h(SettingsForm, {
            labels,
            state: { ...state, saving: busy },
            onSave: () => { setError(''); actions.save(); },
            onDiscard: actions.discard,
          },
          renderField(fields[0], 0),
          h(SettingsSecretField, {
            id: 'dingtalk-bridge-client-secret',
            label: 'Client Secret（AppSecret）',
            hint: enabled
              ? '关闭桥接后可以更换机器人凭证。'
              : '密钥保存在 DSH 的本机凭证库中，保存后只显示配置状态。',
            text: state.secretDraft,
            configured: credential?.configured === true,
            stateLabel: credential === null ? '正在读取'
              : credential.failed ? '状态不可用'
              : credential.configured ? '已保存' : '未保存',
            disabled: !state.writable || busy || enabled || credential?.writable === false,
            onEdit: (text) => { setError(''); actions.edit('clientSecret', text); },
          }),
          ...fields.slice(1).map((field, index) => renderField(field, index + 1)),
          state.dirty && h(Button, {
            variant: 'outline',
            size: 'sm',
            disabled: busy,
            onClick: actions.discard,
          }, '放弃修改')),
        );
      }

      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dingtalk-dsh',
      }, BridgeSettings)));
      ctx.effect(() => ctx.slots.inject('conversation.chat.user.before', () => ctx.slots.register({
        name: 'conversation.chat.user.before',
        select: ({ kind, source }) => kind === 'user' && typeof source?.dingtalkMetadata === 'string'
          ? source.dingtalkMetadata : null,
      }, DingTalkOrigin)));
    }

    return { inject: ['slots', 'configForms', 'remote', 'remote.credentials'], apply };
  },
});
