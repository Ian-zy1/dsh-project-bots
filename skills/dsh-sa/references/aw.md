# AW快照与结果字段

AW保存Owner提供的需求、任务与固定背景，不审批或调度。原始需求保留项目引用；执行端读取快照不代表获准开工。传输命令见 [operations.md](operations.md)，不要为发布/读取另写远端脚本。

## 项目与需求

- `GET /projects/:id`：复用连接配置中的项目，核对repositoryUrl、baseline、environment、rules。用需求本次选定的完整Git SHA，不误用浮动分支或别的AW实例ID。
- `PUT /projects/:id`：`expectedRevision`及实际变化字段。项目环境含工具版本、profile、验证命令及必要依赖条件；凭据留执行环境。
- `POST /requirements`：`projectId,title,description,plan,acceptance`，记录Owner形成的计划。
- `PUT /requirements/:id`：带`expectedRevision`。冲突时读现状，不覆盖他人修改。

## 任务与固定快照

`POST /requirements/:id/tasks`带固定`Idempotency-Key`，正文：

```json
{"expectedRevision":1,"tasks":[{"key":"T1","title":"任务标题","description":"批准范围与原需求引用","acceptance":"可核对的验收","dependsOn":[]}]}
```

只保存Owner已拆好的任务，不自动拆分。已批准背景通过`GET /tasks/:id/brief?revision=N`与`GET /tasks/:id/context?revision=N`回读；按需加`section=task|project|requirement`。task与验收完整读，brief不代替正文。快照保存后固定版本，不追随latest。

### 执行与交付约定

Owner把关键业务边界写入现有`task.acceptance`，将下列短约定附入同版`task.description`，使Worker实际读到；不要只留在本机skill或另建核对文档。它适用于获准提交的代码实施任务，其他阶段服从当轮授权，不因交付要求越权实施/提交或伪造SHA。

> 按批准版本和验收实现，不自行改口径。交付简列“验收项→代码/测试证据、未满足项”，注明完整候选SHA、验证命令/环境/结果和证据位置；及时保留各轮日志及测试报告，避免后续clean覆盖。原生独立Reviewer读取同版taskId/revision、完整验收或可读固定引用、基线和候选SHA，独立检查实现并明确批准的SHA。评审不默认重跑已有测试：仅代码/环境/命令变化、覆盖或证据不足、发现具体风险时补相关验证。提交前测试须能证明测试代码树与候选一致且无遗漏改动；仅提交时间较晚不是重跑理由，无法证明则保持pending或补跑。项目明确门槛优先；新SHA不得直接沿用旧批准，须补影响范围验证和独立增量确认。缺证先报进度/阻塞，最终覆盖齐全才报ready。

同一任务经用户确认变更口径时，生成新快照并明确授权适用版本；Worker与Reviewer都依据该版本，旧版验收/批准不混用。上述对照和确认直接留在现有任务、回报与评审产物内。

使用飞书群接续时，在任务描述中补充：`orchestrator_report` 报 `ready` 时用 `candidate_sha` 提供已复核的完整候选 SHA。

`PUT /tasks/:id`带`expectedRevision`，背景刷新要显式生成新版本；当前状态与内容版本分开。手工状态更新：

```json
{"expectedRevision":1,"expectedStatusRevision":1,"status":"in_progress"}
```

用于`PATCH /tasks/:id/status`；值为draft/ready/in_progress/blocked/done。记录真实阶段，不因发送消息就标done。

## 候选与报告

- `POST /tasks/:id/candidates`带幂等键：至少`executorName,taskRevision`；`executorKind`仅用`superagent/local-agent/human`，`method`为执行方式说明。可带`sourceRef,baseSha,branch,sha,prUrl`，没有SHA或MR时不编造。
- `GET /tasks/:id/candidates`及`GET /tasks/:id/candidates/:cid/reports`：接续先查原候选，不重复建。
- `POST /tasks/:id/candidates/:cid/reports`带幂等键：`kind,summary,sourceRef,submittedBy`；kind为progress/blocked/delivery/review。review另带`reviewedSha,verdict,reviewedBy`，verdict为accepted/changes_requested/pending；SHA为完整40位。
- Owner代录注明原生来源与实际执行者/评审者。独立Reviewer与Owner复审分别记录，证据绑定最终候选SHA。

当前实例Worker只读AW，Owner代录结果；AW报告时间可能滞后，实时执行状态查原生Ticket。不同环境接入、迁移与发布均需对应授权，不因这些字段自动启用新服务。
