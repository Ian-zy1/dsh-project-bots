# DSH Project Bots

**一个项目，一个 Bot。把注意力留给决策，同时多试几个方向。**

One bot per project. Delegate approved work to DeepSeek Harness Superagent and review the result in the conversation where it started.

我给每个业务项目配一个 Bot，就像给自己多了一个项目分身。我定方向、确认方案。Bot 接下任务，由 Superagent 在项目的工作区实现、测试和评审。结果回到发起需求的 Codex 会话，我看候选和证据，再决定是否合入。

![架构动图，确认需求后按项目派活，两个 Bot 各自执行，交付回到对应的原 Codex 会话](docs/assets/project-bots-flow.gif)

[静态架构图](docs/assets/project-bots-flow.png) · [安装指南](docs/install.md) · [真实案例](docs/example.md) · [部署边界与交接时序](docs/architecture.md)

## 两个项目，两种尝试

| 项目 | 交给 Bot 的事 | 交回来的结果 |
| --- | --- | --- |
| 设备巡检台 | 增加「仅看异常」筛选和结果数 | 可以操作的候选页面，覆盖异常新增、恢复和筛选切换。 |
| 站点状态页 | 给已经恢复的故障展示时长 | 已恢复记录显示「1 小时 15 分钟」，未恢复记录显示「持续中」。[完整案例](docs/example.md) |

一个 Bot 对应一个业务项目。项目里的前端、后端可以各用自己的仓库和工具链，任务按批准版本选仓。

## 在 Superagent 上扩展了什么

- **项目与任务绑定。** AW 固定批准范围、仓库、基线和验收条件，执行和评审引用同一版本。
- **项目 Bot 执行。** DSH Superagent 沿用原生接单、Ticket、Worker 和回报能力，产出可审查的代码候选。
- **交付接回原会话。** 飞书传递任务引用和回报。Owner Relay 按原任务和话题把交付接回发起需求的 Codex 会话，Owner 对照实际差异与证据复审。

这套用法延续上游少占人的注意力、在有结果或需要决策时回到人的原则。[DeepSeek 团队的设计说明](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)

## 当前版本

仓库提供可安装候选源码、Compose、Owner Skill 与演示项目。Mac Apple Silicon 和 Linux x86_64 已通过基础安装，验证了服务启动、DSH 读取 AW 和重启后的数据保留。本次发布候选的真实首单闭环待验收。首页动图取材于两个已完成的实验案例，以并排方式展示独立项目路径。[安装指南](docs/install.md)

本项目是对 DeepSeek Harness Superagent 的独立扩展。各组件和第三方依赖的许可见相应源码和发布说明。
