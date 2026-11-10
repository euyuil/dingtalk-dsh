# 钉钉与 DeepSeek Harness 聊天桥接

将钉钉机器人接入 DeepSeek Harness（DSH），在钉钉单聊或群聊中发送文字并收到回复。

## 选择运行方式

- **桌面插件**适合已经在用 DSH 桌面客户端的用户。插件沿用桌面端配置的模型，钉钉会话可以在桌面查看。
- **CLI 独立服务**适合在一台机器上独立运行桥接的用户。需要 DeepSeek API Key。

## 准备钉钉机器人

1. 在钉钉开放平台创建企业内部应用，启用机器人能力，选择 **Stream 模式**。
2. 配置应用的可使用范围并发布版本。
3. 从应用凭证页取得 AppKey（Client ID）和 AppSecret（Client Secret）。

## 安装和启动

源码安装需要 Node.js 24.x（至少 `24.13.0`）。先克隆本仓库，再在仓库根目录打开 PowerShell。

### 桌面插件

先在 DSH 桌面客户端配置一个可用模型，然后打包插件。

```powershell
npm.cmd ci
npm.cmd run pack:plugin
```

1. 在 DSH 桌面端打开「插件 → 添加插件」，填入生成的 `dingtalk-dsh-<版本>.tgz` 的完整路径，安装后启用插件。
2. 在「已安装插件」中打开 `dingtalk-dsh`，填写 Client ID 和 Client Secret，点击「保存配置」。其他字段可留空。
3. 打开详情页中的「启用钉钉桥接」。

### CLI 独立服务

```powershell
npm.cmd ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

在 `.env` 中填写 `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET` 和 `DEEPSEEK_API_KEY`，然后构建并启动。

```powershell
npm.cmd run build
npm.cmd start
```

服务运行期间保持终端开启，按 `Ctrl+C` 停止。

## 验证连接

看到终端或桌面宿主日志中的「钉钉连接已建立」后，先私聊机器人发一条文字消息，确认能收到回复。群聊中发送消息时需要 @机器人。

- 同一个机器人一次只运行一种模式。切换前先停止原来的入口，两种模式各自保留会话历史。
- 每个聊天有独立的会话。同一群内的成员共享该群会话，同一个桥接实例内的聊天共享文件工作区。

## 参考

- [使用与配置](docs/usage.zh-CN.md)涵盖高级选项、升级备份和常见问题。
- [架构说明](docs/architecture.md)和[贡献指南](AGENTS.md)面向开发者。
- [MIT 许可](LICENSE)
