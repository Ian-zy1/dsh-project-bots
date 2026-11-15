import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute } from 'node:path';

const execute = promisify(execFile);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
// Native queue owns busy/idle scheduling. No second App Server, model, UI automation or resume.
export class NativeQueue {
  constructor(config, run = execute) { this.config = config; this.run = run; this.abort = new AbortController(); }
  async dispatch(b, e, config) {
    if (!isAbsolute(this.config.codexCli)) throw Error('Configure the verified absolute native Codex CLI');
    const relayCommand = config.configPath
      ? `OWNER_RELAY_CONFIG=${quote(config.configPath)} node ${quote(config.cliPath)}`
      : `node ${JSON.stringify(config.cliPath)}`;
    const text = `[Owner Relay event ${e.eventId}]\n`
      + '这是已授权任务的结果接续，不是新的实施/重试/合入授权。先登记实际接手；登记失败立即停止，不另建会话。\n'
      + `执行：${relayCommand} started ${e.eventId}\n`
      + `固定快照摘要：${b.snapshotDigest}；执行事实：${JSON.stringify(e)}\n`
      + (b.contextRef ? `原Owner登记的上下文引用：${JSON.stringify(b.contextRef)}。\n` : '')
      + (e.type === 'implementation.ready' ? '沿原任务核对批准计划、原Ticket/Report、实际候选diff和独立评审证据，完成Owner最终复审。复用有效验证；缺证为pending，不重复派活或构建。'
        : '仅核对原任务失败/阻塞原因；不得自行重试、派活或实施。')
      + `\n将结论保存为实际证据文件，再执行：${relayCommand} complete ${e.eventId} <receipt.json>。`
      + 'receipt字段：taskId、revision、candidateSha、conclusion(accept/revise/pending)、artifact(实际证据绝对路径)。不合入、不推送、不部署。';
    const { stdout, stderr } = await this.run(this.config.codexCli, ['queue', '--thread', b.threadId, '--message', text],
      { timeout: 15000, signal: this.abort.signal, maxBuffer: 100000 });
    const match = /^Queued message ([a-f0-9-]+) for thread ([a-f0-9-]+)\.\s*$/.exec(stdout.trim());
    if (!match || match[2] !== b.threadId || stderr.trim()) throw Error('Native queue result unknown');
    return { queueId: match[1] };
  }
  close() { this.abort.abort(); }
}
