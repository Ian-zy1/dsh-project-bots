---
name: dsh-sa
description: "作为项目 Owner 使用 DSH Superagent。接入项目、形成实施计划和 AW 固定快照、经授权派活，并对照候选代码复审交付。"
---

# DSH Superagent Owner

按当前请求只进入一个模式。每个项目会话独立担任 Owner，AW 保存固定快照，DSH 执行。

| 当前请求 | 先读 |
| --- | --- |
| 首次接入，或变更仓库、环境、Bot | [初始化](references/init.md) |
| 提出需求、批准计划、授权派活或明确继续已有阶段 | [创建需求](references/create.md) |
| 收到 Owner Relay 事件，或用户要求复审候选 | [复审](references/review.md) |

各模式包含输出模板。引用的操作资料只在对应步骤加载。正常新需求复用已验证的项目连接；入口缺失才转初始化，保留已完成步骤。

沿用项目规则、zy-track 和 collab 角色门槛。优先用独立短会话；续接原工作目录、批准版本、发送回执和 Ticket。计划确认、派活、重试、合入、部署各按相应授权执行。结果不明先查原回执和原任务，禁止换键重发。
