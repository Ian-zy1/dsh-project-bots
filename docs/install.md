# 安装 DSH Project Bots

DSH 和 AW 使用同一个 Compose 文件。Owner Relay 和 Codex 放在你的工作电脑，接续发生在发起需求的原会话。每个业务项目用独立的 Compose 项目名、Bot、配置目录和数据卷。

## 从空状态启动

运行 DSH 的机器需有 Docker 和 Compose v2 或以上。把安装配置留在 checkout 之外。

```sh
profile="$HOME/.config/project-bots/demo"
mkdir -p "$profile"
chmod 700 "$profile"
cp deploy/instance.example.json "$profile/instance.json"
cp deploy/installation.env.example "$profile/installation.env"
(
  umask 077
  printf 'Bearer %s\n' "$(openssl rand -hex 32)" >"$profile/dispatch-authorization"
)
```

在 `installation.env` 中把 `PROJECT_BOTS_CONFIG_DIR` 改为 `$profile` 的实际绝对路径。一个实例用一对未占用的主机端口。容器以 UID 1000 运行，按宿主机的文件权限将配置目录授予该 UID 只读访问。测试配置中的凭据文件也仅授权该运行身份。

```sh
docker compose --env-file "$profile/installation.env" -p project-bots-demo \
  -f deploy/compose.yaml up -d --build --wait
deploy/doctor.sh project-bots-demo "$profile/installation.env"
```

默认 AW 地址为 `http://127.0.0.1:4319/`。DSH 私有启动地址可由安装者在终端读取。地址含临时登录令牌，需要当作凭据使用。

```sh
docker compose --env-file "$profile/installation.env" -p project-bots-demo \
  -f deploy/compose.yaml exec -T dsh cat /state/web-url
```

云端由工作电脑构建服务器架构的镜像。以 Linux x86_64 为例，下面的镜像名与服务器上的 Compose 项目名一致。

```sh
docker buildx build --platform linux/amd64 --load -f deploy/Dockerfile.superagent -t project-bots-demo-dsh .
docker buildx build --platform linux/amd64 --load -f deploy/Dockerfile.workboard -t project-bots-demo-workboard .
docker image save project-bots-demo-dsh project-bots-demo-workboard | gzip > project-bots-amd64.tar.gz
```

把安装文件和镜像包上传到服务器，按前文在服务器创建私有配置。导入镜像后，用 `--no-build --pull never` 启动。

```sh
docker load -i project-bots-amd64.tar.gz
docker compose --env-file "$profile/installation.env" -p project-bots-demo \
  -f deploy/compose.yaml up -d --no-build --pull never --wait
deploy/doctor.sh project-bots-demo "$profile/installation.env"
```

用下面的命令在工作电脑打开两套界面。两端使用相同的端口和来源。服务端口只监听回环地址。

```sh
ssh -N -L 4319:127.0.0.1:4319 -L 4320:127.0.0.1:4320 user@server
```

用同一项目名执行 `docker compose … down` 停止实例并保留数据卷。替换版本前保留镜像和卷的备份。要评估新版本时使用独立项目名和不同端口。

## 接入一个演示项目

1. 把 `examples/status-page/` 初始化为你的 GitHub 测试仓库，以 Node 24 执行 `npm run check` 和 `npm start`。
2. 以 [项目样例](../deploy/workboard.project.example.json) 为基准，用 [Owner 脚本](../skills/dsh-sa/references/operations.md#1-连接与状态) 的 `aw /projects --method POST --body /absolute/project.json` 注册 AW 项目。Owner 写入从 AW 容器回环执行，浏览器提供只读看板。把返回的项目 ID 配进 DSH 的 `superagent.awProjectId`，同时按飞书样例填写 `awRepositories`。两侧的 `repoId`、仓库 URL 和 `environmentRef` 一致，任务批准时冻结完整 Git SHA。
3. 通过 DSH 的模型配置添加测试模型。也可在私有目录放入 DSH 能加载的 `model.patch.yml`。按所选模型提供方配置密钥。通过 DSH 的 Sources 和 Execution 面板配置 GitHub 仓库、可读的 Git 登录以及 Ticket 工作区。参考 [Superagent 配置](../components/superagent/docs/006-deployment.md)。
4. 把 DSH Bot 和 Relay Bot 加入同一测试群。在服务器私有目录保存 `feishu.json`，字段是 `appId` 和 `appSecret`。参考 [飞书接入样例](../deploy/instance.feishu.example.json) 编辑 `instance.json` 并重启 DSH。已有数据卷从 DSH 面板启用 Feishu Source，CLI 填 `/state/bin/lark-bot`，配置测试群和仅响应 @。在 Policy 的飞书允许名单加入派活用户，以 DSH Bot 应用视角取得用户的 `open_id`。
5. 在 Owner 电脑独立配置飞书 CLI 的用户发送授权和 Relay Bot 登录。复制 [Owner 配置样例](../deploy/owner.example.json) 和 [Relay 配置样例](../deploy/relay.example.json) 到私有目录。飞书的 `open_id` 按读取它的应用分别确认。云端模式在 Owner 的 Compose 配置中填写 SSH 主机别名和服务器上的路径。确认 Codex CLI 能运行 `codex queue --help`。

```sh
export DSH_SA_CONNECTION=/absolute/private/owner.json
OWNER_RELAY_CONFIG=/absolute/private/relay.json node components/owner-relay/cli.mjs run
```

## 用首单验收

在演示仓库的新 Codex 会话用 `$dsh-sa` 提出「已恢复事件显示从开始到恢复的时长，未恢复显示持续中」。确认实施计划和 AW 快照后派活。依次核对接单、同一个 SHA 的候选和独立评审、原 Codex 会话实际接手，以及原飞书话题的最终复审。Owner 在项目工作区启动候选页面，对照演示数据后再决定是否合入。
