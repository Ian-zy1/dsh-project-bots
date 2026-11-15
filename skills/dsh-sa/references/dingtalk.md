# 钉钉单聊

已验收实例与API步骤见 [operations.md](operations.md)。本机连接配置中的dingtalk记录明确profile、机器人ID和会话ID；历史verified表示接通过，不替代当前身份与运行态核对。

## 身份与契约

发送前读已安装的 `dingtalk-chat` skill及其`references/chat/chat-bot.md`，按实际CLI leaf Schema与Runtime gate执行。当前已验v1.0.68；不因旧版本记录跳过必要契约核对。

- 用`dws auth status --format json`核对身份；必要时`dws profile list --format json`确认当前组织。解析、发送和读回使用同一明确profile，不自行切组织。
- 优先复用配置中已确认的目标。首次、用户更换目标或身份有歧义时才用`chat +bot-find`消歧，不替换成他人/群/Webhook。openDingTalkId与robotCode不能混用。
- Source当前连通性用`access.py sa /state`核对；已验收协议不再逐单翻编译包或数据库。

## 经授权发送及读回

先核对`dws schema --cli-path 'chat +messages-send' --compact --format json`，正文按operations.md固定协议。已验调用形式：

```text
dws chat +messages-send --as user --open-dingtalk-id CONFIGURED_ID --text - --body-stdin --idempotency-key STABLE_KEY --wait-delivery --profile CONFIGURED_PROFILE --format json
```

内容通过subprocess argv/stdin传入，不拼到shell。发送前展示目标、内容和范围；按该次用户确认及最终Runtime gate执行。遇confirmation_required不得未经确认自动加--yes；已明确确认原操作时按产品skill的确认协议处理，不要求重复批准同一操作。

回执含conversationId/openMessageId/deliveryStatus/idempotencyKey；再按`chat +messages-mget`的实际Schema回读该消息，核对正文和身份。超时或结果未知先查原回执，保持同一key，不换key重发。

消息送达不等于Ticket建立。随后用operations.md的search/ticket核对；将对应ID与证据关联AW。实例为Git-only时无需GitLab API Token或glab，不把建Issue/MR作为派活前提。

## 只在接入缺失时处理

CLI未安装、登录过期或目标未知时，按产品skill处理相应缺口；不擅自安装/重启远端服务。安装获授权时使用官方dingtalk-workspace-cli，已有产品skills时设DWS_NO_SKILLS=1避免覆盖。

普通DSH钉钉会话不等于Superagent Source；部署未知时只报告已确认层级。当前已验扩展Source的实例直接使用其本地配置，不退回“上游仅GitHub/飞书”而重新调研。失败通知和外部Owner唤醒限制见operations.md。
