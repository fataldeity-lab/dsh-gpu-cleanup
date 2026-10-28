# dsh-gpu-cleanup

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web UI 插件：**点一下**把本地模型占着的 GPU 显存腾出来，同时**保留 llama-swap 本身运行**（它是调度器，不该跟着一起关）。

两个入口，都是「一次点击、没有二次确认」：

1. **设置 → 插件配置 → dsh-gpu-cleanup**：一个大按钮「一键释放显存」，带控制服务健康状态和完整日志；
2. **对话页右上角**（Session log 按钮旁）的「释放显存」小按钮，结果落在右下角浮层里（Esc 关闭，成功 12 秒后自动收起）。

点下去发生的事：

- 调 llama-swap `POST /api/models/unload` 卸载所有已加载模型（保持 llama-swap 存活）；
- 扫掉残留的 `llama-server` / `ninfer-serve` / `strata` 引擎进程，但**只杀启动超过 90 秒的**——刚起来的那个很可能正在给你生成回复，杀了会断掉当前回答；
- **复核**清扫结果：`taskkill` 失败（权限、进程受保护）会如实报「清理失败，仍驻留」，不会谎报已清理；
- 复查 11435 仍在线，并把「还剩哪些引擎」写进日志。

浏览器不能直接调 llama-swap（跨端口、对方不发 CORS 头），所以真正的活都在 DSH 宿主进程里做，浏览器只调本机控制服务 `http://127.0.0.1:11436`：

| 端点 | 作用 |
| --- | --- |
| `GET /health` | `{ ok, version }`，卡片里的「控制服务：正常」就是打这个 |
| `GET /status` | 当前有哪些引擎、llama-swap 是否在线、哪些模型已加载 |
| `POST /free-vram` | 卸载 + 清扫 + 复查，返回逐步日志（按钮就调这个） |
| `GET /list-llama` | 只读列出引擎 PID（旧版兼容） |
| `POST /kill-llama` | 清扫引擎（旧版兼容，同样只杀 90 秒以上的） |

**安全边界**（0.2.1 起）：这个服务能结束进程，所以不对外开放。

- 只绑 `127.0.0.1:11436`，并要求 `Host` 头是 loopback；
- 不再回 `Access-Control-Allow-Origin: *`，只回显 loopback origin，其他站点一律 403；
- 所有 `POST` 必须带 `X-DSH-Plugin: gpu-cleanup` 头——浏览器跨站页面拿不到这个头（会先触发我们拒绝的预检）。

改动前的老版本给任何网页都留了 `POST /free-vram` 的入口，等于允许任意站点 taskkill 你本机的推理引擎。

## 安装

### 方式一：GitHub（本维护版）

```bash
dsh plugin --profile web add github:fataldeity-lab/dsh-gpu-cleanup
```

### 方式二：本地源码目录（改代码时用）

```bash
dsh plugin --profile web add I:/DPHs/dsh-gpu-cleanup
```

### 方式三：手动

```bash
mkdir -p ~/.dsh/profiles/node_modules/@princepainter
cd ~/.dsh/profiles/node_modules/@princepainter
git clone https://github.com/fataldeity-lab/dsh-gpu-cleanup.git
```

> 本包已在 package.json 声明 `dsh.bundle.patch`（`cordis.patch.yml` 自动装配层），
> 所以 `dsh plugin add` 会把插件作为 profile bundle 激活，**无需**再手动往
> `~/.dsh/profiles/web/cordis.patch.yml` 里 `insert`（手动 insert 会和 bundle 层重复挂载）。

### 重启并刷新

`bundles` 列表是**启动时**读的，刷新页面不会加载新插件：

1. 重启 DSH Web 宿主；
2. 浏览器 **强制刷新**（`Ctrl+Shift+R`）；
3. 对话页右上角出现「释放显存」按钮即成功；设置卡里「控制服务：正常（v3）」说明 host 端也起来了。

## 使用

1. 打开 DSH Web UI（`http://127.0.0.1:3080`）；
2. 点右上角 **「释放显存」**（或设置卡里的 **「一键释放显存」**）；
3. 按钮变成「释放中… 3s」并显示实时耗时，右下角浮层滚出逐步日志；
4. 出现「确认：当前没有已加载模型，显存已释放」就完成了——llama-swap 仍在运行，下次用模型自动按需加载。

## 工作原理

```text
按钮 (浏览器, 127.0.0.1:3080)
  └─ POST 127.0.0.1:11436/free-vram   (X-DSH-Plugin: gpu-cleanup)
       ├─ GET  :11435/v1/models        ← 配置了哪些模型
       ├─ GET  :11435/running          ← 真正占着显存的那些
       ├─ POST :11435/api/models/unload← 卸载全部（llama-swap 进程不动）
       ├─ PowerShell 列引擎进程 + 启动时长
       ├─ taskkill /f /pid <age≥90s>   ← 只杀陈旧引擎
       ├─ PowerShell 再列一次          ← 复核：真死了才算 killed
       └─ GET  :11435/v1/models        ← 复查调度器仍在线
```

不做的事：不关 llama-swap、不动 `comfyui` / ollama、不杀 90 秒内的新引擎、不删任何模型文件。

## 技术架构

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | **宿主端**：控制服务（11436）、llama-swap 调用、PowerShell 进程枚举、`taskkill` 清扫与复核 |
| `lib/client.js` | **浏览器端**：右上角按钮 + 右下角浮层 + 设置卡，共享一个迷你 store（不依赖 `dsh-client-store`） |
| `lib/invariant.js` | Invariant 占位，满足 DSH dual-face 协议 |
| `cordis.patch.yml` | bundle 装配层，把插件插进 profile 的层栈 |

按钮通过 DSH 的 slot 系统注入，与官方「Session log」按钮同属 `conversation.session.header.utilities` slot，风格自动保持一致。

## 变更记录

### 0.2.1

- **安全**：去掉通配 CORS + 强制 `X-DSH-Plugin` 头 + 校验 `Host`/`Origin`，堵掉任意网页触发 taskkill 的路径；
- **准确性**：清扫后复核进程表，`killed` / `stubborn` 分开报，不再把失败当成功；
- **性能**：引擎列表 800ms 缓存（一次点击的 PowerShell 调用从 3–4 次降到 2 次），并发 `taskkill`；
- **健壮性**：宿主端 `/free-vram` 单飞（两个标签页同点不会跑两遍）、插件 dispose 时关掉控制服务、端口被占用时探测已有实例而不是反复重试；
- **体验**：请求 210s 超时（llama-swap 卡住不再永远「释放中」）、按钮显示实时耗时、Toast `aria-live` + Esc 关闭 + 成功自动收起、设置卡显示控制服务健康并可重新检测；
- 移除未使用的 `@deepseek-ai/dsh-client-locale` 注入。

### 0.2.0

- 宿主端控制服务（11436）+ 浏览器端按钮/设置卡；
- peer 对齐 DSH `0.2.0-rc.2`，去掉并不存在的 `@deepseek-ai/dsh-client-runtime`。

## 依赖

- DeepSeek Harness `0.2.0-rc.2`（peer 已对齐 `^0.2.0-rc.2`，不再支持 0.1.x）
- llama-swap 在 `127.0.0.1:11435`（可选：没在跑时按钮照常显示，点了只清扫孤儿引擎并给出提示）
- host 端只用 Node 内置 `node:child_process` / `node:http`，没有任何运行时 npm 依赖；不再引用 0.1.x 时代的 `@dsh-plugin/dsh-loader` 与 `@deepseek-ai/dsh-client-runtime`

## License

MIT
