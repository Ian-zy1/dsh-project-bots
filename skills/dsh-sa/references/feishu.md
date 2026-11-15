# 飞书派活与原 Owner 接续

本机私有连接配置见 [operations.md](operations.md)。顶层 `cli`、`larkConfigDir`、`botOpenId`、`chatId` 分别提供 CLI、用户登录目录、DSH 机器人身份和单聊地址。`ownerRelay.chatId` 指向验收过的派活群，`ownerRelay.entrypoint` 指向本机接收端 CLI。App Secret 和用户 Token 由 lark-cli 保存。

## 发送

飞书群派活前确认本机 Relay 在线，原工作区会话有 `CODEX_THREAD_ID`。沿已配置的入口与 `OWNER_RELAY_CONFIG` 核对接收端；有进程锁时先核对 PID，避免启动第二个实例。

若连接配置有 `ownerRelay.autoDispatchBinding: true`，用 `python3 scripts/dispatch.py --config CONFIG --brief BRIEF --snapshot CONTEXT --key KEY` 预览。用户确认文案及固定版本后加 `--send --receipt ABSOLUTE_PATH`。脚本先登记原会话，再代发并保存回执。返回 `sent` 即可结束当前轮。Relay 匹配接单事件，拒绝或评估超时由 DSH 在原话题说明，结果未确认由 Relay 提醒。发送异常先核对原消息和已保存的回执；只补记已核验的回执，禁止重复发送。

旧版群入口用 `python3 scripts/feishu_dm.py --config CONFIG --group --message /absolute/message.txt --key STABLE_KEY`。消息文件写 [AW 单行协议](operations.md#3-批准后发送)，脚本自动 @DSH。用户批准该版本和实施范围后，加 `--send` 以用户身份发送并保存回执。明确选择单聊时省略 `--group`。结果不明时查原消息和 Ticket，沿用原幂等键。

用户登录失效时，通过原配置目录运行 lark-cli `auth login`，由用户完成设备授权后用 `auth status --json --verify` 核实。发送需 `im:message.send_as_user` 和 `im:message`。核对当前身份、目标群及 DSH 机器人后继续。

## 旧版手动绑定

Owner 用发送回执和原生 Ticket 确认原消息、任务版本及 Assignment，在原会话的项目工作目录执行 `node ENTRYPOINT bind /absolute/binding.json`。绑定字段为 `projectId/taskId/revision/ticketId/assignmentId/threadId/cwd/originMessageId/snapshotDigest/authorized`，其中 `revision` 为数字、`authorized` 为 true。`originMessageId` 取原发送回执，`snapshotDigest` 取同版 brief 的 `snapshot.digest`。可用 `contextRef` 指向固定快照或原需求。登记后结束当前轮。

## 接手与回执

按事件提示以原会话执行 `started EVENT_ID`，按 [复审](review.md) 核对证据。保存原件后执行 `complete EVENT_ID /absolute/receipt.json`，再读回飞书原话题。回执字段为 `taskId/revision/candidateSha/conclusion/artifact`，`conclusion` 为 `accept/revise/pending`，`artifact` 为原件绝对路径。阻塞或失败且无候选时省略 `candidateSha`。本机 Relay 按事件给出的原配置执行命令。

查状态时用 `node ENTRYPOINT status` 按 Task 或 Ticket 过滤，区分入队、接手和最终送达。原会话未加载或暂停时打开原会话接续。结果不明查原队列和原话题。
