# 连接与命令

本机非密钥配置：`~/Library/Application Support/dsh-sa/connection.json`；`DSH_SA_CONNECTION`或脚本`--config`可切换实例。地址、账号、容器和项目ID只在配置，不写死到通用skill。

按当前项目明确选择连接，复用该项目的已有验证。派活前另查当前运行态，工具链以项目配置为准。

## 1. 连接与状态

下文`scripts/access.py`指本skill脚本；实际调用替换为绝对路径，保持项目工作目录。`connection`和`--dry-run`只读本地；其余命令会访问所配实例，须在当轮允许的环境范围内执行。

```sh
python3 scripts/access.py connection --config CONFIG
python3 scripts/access.py sa /state --config CONFIG
python3 scripts/access.py aw /projects/PROJECT_ID --config CONFIG
python3 scripts/access.py worker-aw '/tasks/TASK_ID/context?revision=N' --config CONFIG
```

`state`核对`setup.problem`、仓库、所选IM Source、paused和load；Runtime与IM应ready。当前Git-only的`health.gitlab=paused`表示API关闭，是预期配置。state不证明模型提供方可用。不要为健康检查重试/重启或试派任务。

`aw`走 AW 容器回环接口。`worker-aw`从 DSH 容器访问私网只读 AW，无需启动 Worker。云端操作走配置中的 SSH 主机。

Compose 或 SSH 访问失败时先核对连接指向的实例和容器状态。AW 错误显示 HTTP 状态及有限的校验文本，DSH 只显示 HTTP 状态。配置失败标明尚未发请求。超时视为结果不明，先核对原回执。

## 2. 发布并回读快照

字段见 [aw.md](aw.md)。正文写本地JSON文件：

```sh
python3 scripts/access.py aw /requirements --config CONFIG --method POST --body /absolute/requirement.json
python3 scripts/access.py aw /requirements/REQ_ID/tasks --config CONFIG --method POST --body /absolute/tasks.json --key STABLE_BATCH_KEY
python3 scripts/access.py aw '/tasks/TASK_ID/brief?revision=N' --config CONFIG
python3 scripts/access.py aw '/tasks/TASK_ID/context?revision=N' --config CONFIG --output /absolute/fixed-context.json
```

项目ID取配置并核对仓库，新需求重新固定Git基线。发布前可用同参数加`--dry-run`离线检查JSON、路径和必要幂等键；它不代替AW字段校验，不截断业务正文。失败先读具体错误；写入结果不明先回读，原请求重试保留原key，内容变更先确认原请求未成功。

`brief.snapshot`含task/requirement/project版本和digest，完整 context 提供任务说明及验收。飞书自动派活必须带同一固定版本的 brief 和 context，已有文件直接复用。复审按缺失证据补读。首次或环境有变时从`worker-aw`读取同版上下文。

## 3. 批准后发送

固定单行协议仅在此定义：

```text
AW taskId=TASK_ID revision=N phase=implement scope=Owner Agent代发；用户已批准的具体范围；不合入不部署
```

仅远端计划用`phase=plan`；本地计划已批准时直接implement，不另派远端规划。背景留AW。身份、CLI契约、门禁和回执按所选通道reference执行。

## 4. 关联原生任务

```sh
python3 scripts/access.py sa '/search?q=TASK_ID' --config CONFIG
python3 scripts/access.py sa /tickets/TICKET_ID --config CONFIG --output /absolute/native-ticket.json
```

发送回执确认msg ID与原文。搜索的`items[].disposition.decision.ticketId`或`items[].disposition.fanout[]`关联Ticket；`tickets[]`也可能按标题命中，不能假设taskId必在该数组。未出现只报告待入站/路由，不重发。Ticket的`decision`、`threads`、`sessionId`、`directory`、`assignments`、`environment`对应原消息和执行环境；`startedAt/ref`证明启动，`DSH_SUPERAGENT_BASE_SHA`供核对基线。

当前HTTP视图不直接暴露全部内部AW绑定/digest字段；固定绑定由已验收Runtime校验，不每单探库。Worker实际读取版本由回报/产物核对，未独立取得则待核，不能冒充本次逐字段验证。保存AW ID/版本、msg ID、Ticket、Session、基线和证据路径，结束当前轮。

## 5. 结果与阻塞

接续仍读`sa /tickets/TICKET_ID`。`stage=person`且最新`assignments[].report.state=failed|blocked`表示等处理；Assignment自身仍可显示running，要结合Report、`turnEndedAt`及state.load判断。

以实际消息或回执确认IM送达。指定群中已绑定的实施任务可接续完成、阻塞和失败事件。准备阶段尚无固定AW上下文时，沿原生人工失败通知处理。GET用于查看原Ticket，重试需相应授权。

候选/报告回写仍用`aw`，字段见aw.md；代录标明来源，独立评审后另做Owner复审。
