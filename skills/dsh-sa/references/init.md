# 初始化

首次接入、连接缺失或仓库、执行环境、Bot 发生变化时加载。输出是已核对的项目连接，可供后续 Owner 会话直接使用。

1. 以用户指定项目和当前工作区为准。显式选择连接文件。按 [连接与状态](operations.md#1-连接与状态) 先读本机配置，核对 AW 项目、实际仓库或仓库清单、Git 基线来源、DSH 实例与执行工具链。一个工作区有多个仓库时明确任务目标仓库；连接记录与项目规则冲突时先报告具体差异。
2. 按本轮授权检查已配的 AW、DSH 和 IM 来源。对同一环境复用已验证的工具配置；首次或条件变化时核对 Worker 能读同版上下文，有固定快照再验证。Git 可读和运行态就绪分别记录。没有固定快照的项目可先标记 Worker 读取待验。
3. 按所选入口检查 Bot、群或单聊、登录与权限。飞书自动接续确认本机 Relay 使用正确群和项目发布者、具备原会话绑定条件。仅在需要通道操作时读 [飞书](feishu.md) 或 [钉钉](dingtalk.md)。将经核对的非密钥连接信息放入该项目连接文件，授权凭据保留在对应 CLI 或私有配置。
4. 按真实检查区分已核对和待验证。缺权限或连接失败时给出具体停点，沿已配置入口恢复；初始化无需试派业务任务。

首次写连接文件时，从已确认的部署资料填入下列最小字段。示例值仅展示格式。

```json
{
  "preferredChannel": "feishu",
  "awProjectId": "prj_example",
  "compose": {"project": "project-bots-demo", "file": "/absolute/deploy/compose.yaml", "envFile": "/absolute/installation.env"},
  "awAccess": {"internalApiBase": "http://127.0.0.1:4180/api/v1"},
  "superagentAccess": {"workerAwApiBase": "http://workboard:4180/api/v1"}
}
```

云端部署在 `compose` 中加入 `sshTarget`（SSH 主机别名或 `user@host`），文件使用服务器上的绝对路径。可选 `awBaseUrl` 填用户可打开的看板地址。发送身份、目标和 Relay 字段按选定通道补齐。目标 DSH 启用接单事件且 Relay 就绪后，开启 `ownerRelay.autoDispatchBinding`。

## 输出模板

- 项目与执行目标：项目、仓库、基线来源、工具链、验证命令。
- 连接：AW 项目、DSH 实例、所选 IM/Bot、Relay，配置文件路径。
- 核对结果：已验证的检查、待验项及需要用户处理的具体事项。
