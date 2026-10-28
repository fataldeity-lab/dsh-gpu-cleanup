# dsh-gpu-cleanup

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web UI 插件：**在插件里点一下**就把本地模型占着的 GPU 显存腾出来，同时**保留 llama-swap 本身运行**（它是模型调度器，不该跟着一起关）。

两个入口，都是「一次点击、没有二次确认」：

1. **设置 → 插件配置 → dsh-gpu-cleanup**：一个大按钮「一键释放显存」；
2. **对话页右上角**（Session log 按钮旁）的「释放显存」小按钮。

点下去发生的事：

- 调 llama-swap `POST /api/models/unload` 卸载所有已加载模型（保持 llama-swap 存活）；
- 扫掉残留的 `llama-server` / `ninfer-serve` / `strata` 引擎进程，但**只杀启动超过 90 秒的**——刚起来的那个很可能正在给你生成回复，杀了会断掉当前回答；
- 复查 11435 仍在线，并把「还剩哪些引擎」写进日志。

浏览器不能直接调 llama-swap（跨端口、对方不发 CORS 头），所以真正的活都在 DSH 宿主进程里做，浏览器只调本机控制服务 `http://127.0.0.1:11436`：

| 端点 | 作用 |
| --- | --- |
| `GET /status` | 当前有哪些引擎、llama-swap 是否在线、哪些模型已加载 |
| `POST /free-vram` | 卸载 + 清扫 + 复查，返回逐步日志（按钮就调这个） |
| `GET /list-llama` | 只读列出引擎 PID（旧版兼容） |
| `POST /kill-llama` | 强制杀掉全部引擎（旧版兼容，不保留新引擎） |

One click inside the plugin (settings card, or the header button) unloads every llama-swap model and sweeps stale local engines, freeing VRAM while llama-swap itself keeps running. All work happens in the DSH host process; the browser only calls the local control server on `127.0.0.1:11436`.

> 装完/改完必须重启一次 DSH Web 宿主：`bundles` 列表是启动时读的，刷新页面不会加载新插件。

## 安装

### 方式一：dsh plugin 命令（推荐）

```bash
dsh plugin --profile web add github:princepainter/dsh-gpu-cleanup
```

### 方式二：手动安装

```bash
mkdir -p ~/.dsh/profiles/node_modules/@princepainter
cd ~/.dsh/profiles/node_modules/@princepainter
git clone https://github.com/princepainter/dsh-gpu-cleanup.git
```

> 本包已在 package.json 声明 `dsh.bundle.patch`（`cordis.patch.yml` 自动装配层），
> 所以 `dsh plugin add` 会把插件作为 profile bundle 激活，**无需**再手动往
> `~/.dsh/profiles/web/cordis.patch.yml` 里 `insert`（手动 insert 会和 bundle 层重复挂载）。
> 若手动列进 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles`，
> boot 会校验 `dsh.bundle.patch`，现在已满足，不会再启动报错。

### 重启并刷新

安装后重启 DSH，然后 **强制刷新**（`Ctrl+Shift+R`）浏览器页面，即可在对话页右上角看到「释放显存」按钮。

## 使用

1. 打开 DSH Web UI（`http://127.0.0.1:3080`）
2. 右上角点击 **「释放显存」** 按钮
3. 弹窗中点击 **「执行」**
4. 等待日志显示 `done_reason=unload`，显存即已释放

## 工作原理

插件调用 Ollama 的 API 卸载模型：

```bash
# 1. 查询当前已加载的模型
GET http://127.0.0.1:11434/api/ps

# 2. 对每个模型发送卸载请求（keep_alive: 0 = 立即卸载）
POST http://127.0.0.1:11434/api/generate
{ "model": "qwen3.8-27b:latest", "keep_alive": 0 }
# => { "done": true, "done_reason": "unload" }
```

Ollama 返回 `done_reason: "unload"` 即代表模型已从显存卸载。

## 技术架构

本插件遵循 DSH 的「一切皆插件」架构，是一个 **dual-face** 包：

| 文件 | 作用 |
|------|------|
| `lib/index.js` | Node 端占位（host half），保证 Cordis loader 可导入 |
| `lib/client.js` | 浏览器端（client half），渲染按钮并注入到 `conversation.session.header.utilities` slot |
| `lib/invariant.js` | Invariant 占位，满足 DSH dual-face 协议 |

按钮通过 DSH 的 slot 系统注入，与官方「Session log」按钮同属 `conversation.session.header.utilities` slot，风格自动保持一致。

## 依赖

- DeepSeek Harness `0.2.0-rc.2`（peer 已对齐 `^0.2.0-rc.2`，不再支持 0.1.x）
- llama-swap 在 `127.0.0.1:11435`（可选：没在跑时按钮照常显示，点了只清扫孤儿引擎并给出提示）
- host 端只用 Node 内置 `node:child_process` / `node:http`，没有任何运行时 npm 依赖；不再引用 0.1.x 时代的 `@dsh-plugin/dsh-loader` 与 `@deepseek-ai/dsh-client-runtime`

## 安装（本仓库维护版）

```bash
# 直接装 GitHub 版（公开仓库，无需 token）
dsh plugin --profile web add github:fataldeity-lab/dsh-gpu-cleanup

# 或装本地源码目录
dsh plugin --profile web add I:/DPHs/dsh-gpu-cleanup
```

装完**重启一次 dsh web**：bundle 层只在宿主启动时挂载。起来后右上角（Session log 按钮旁）出现「释放显存」，插件详情页也有同一个大按钮。

原项目：[princepainter/dsh-gpu-cleanup](https://github.com/princepainter/dsh-gpu-cleanup)（MIT）。

## License

[MIT](./LICENSE)
