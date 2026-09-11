# AGENTS.md

## 项目目标

本仓库用于把三套已经验证的 ComfyUI 漫画去字工作流封装成可发布到 AutoDL 的“开机即用”镜像。最终用户不需要理解 ComfyUI、工作流 JSON、提示词或模型目录，只通过 6008 网页上传原图和黑白 Mask、选择流程、查看进度并下载结果。

开发时优先保证：输入不会错配、单卡运行稳定、任务可恢复、结果可完整下载、镜像不包含用户数据或凭据。不要为了界面简化而破坏这些约束。

## 架构与端口

- `frontend/`：React 19 + TypeScript + Vite + Ant Design。生产环境构建为静态文件，不运行独立 Node 服务。
- `backend/`：FastAPI，同时提供 `/api/*` 和 `frontend/dist/` 静态页面。
- `backend/app/engine.py`：单 GPU 任务队列、批次器调用、进度同步、显存记录、结果整理和打包。
- `backend/app/repository.py`：磁盘 JSON 持久化；本项目暂时没有数据库。
- `runtime-tools/`：已经用于生产测试的批次器、显存监控和 PDF 工具。
- `workflows/`：固定的三套生产工作流副本。
- `config/`：镜像组件、模型和运行时清单。
- AutoDL `WebUI-6006`：原生 ComfyUI，供维护和调试使用。
- AutoDL `WebUI-6008`：普通用户使用的漫画去字网页。
- 后端只能通过 `http://127.0.0.1:6006` 调用 ComfyUI，不要绕到 AutoDL 外部代理地址。

生产环境默认路径：

```text
/root/comic-inpaint                       应用
/root/ComfyUI                             ComfyUI
/root/autodl-tmp/comic-inpaint/jobs       任务、结果与日志
```

不要把某次实例的 SSH 端口、公开服务 URL 或密码写死在仓库里。

## 三套正式工作流

网页中的标准顺序是：

1. `flux2klein_lanpaint`：Flux2 Klein FP8 + LanPaint
2. `firered`：FireRed FP8
3. `qwen2511_lanpaint`：Qwen Image Edit 2511 + LanPaint

网页默认只选择 Flux。用户可只选一套或多选；选择多套时必须串行执行，一套完成后才切换下一套。不要把多张图片组成真正的 GPU Tensor Batch，也不要同时运行多套模型。当前目标硬件是 32 GB GPU。

`backend/app/main.py::WORKFLOW_ORDER` 是网页提交顺序的代码来源；`frontend/src/App.tsx`、`config/runtime.json` 和文档中的顺序应与其保持一致。

三套生产 JSON 中的提示词、sampler、steps、CFG、LoRA、分辨率、LanPaint 和裁切拼接参数都视为已调优参数。除非用户明确要求修改，而且随后安排新的 GPU 回归测试，否则不要改动。仅修改网页、文案或普通后端编排时，不应重写工作流 JSON。

## 输入规则

- 用户提供两组文件：原图和独立黑白 Mask。
- 原图接受 PNG/JPG/JPEG；Mask 只接受 PNG。
- 网页同时支持“选择文件夹”和“一次多选图片”。每次新选择整批覆盖旧选择，不累加。
- 文件夹模式只读取所选目录第一层，不递归选择子文件夹。
- 忽略 macOS AppleDouble 文件 `._*`；制作上传压缩包时使用 `COPYFILE_DISABLE=1` 并确认包内不存在 `._*`。
- 原图与 Mask 必须按 basename stem 配对，例如 `001.jpg` 对 `001.png`；不能依赖目录顺序。
- 提交 GPU 前必须拒绝重复 stem、缺失配对、格式错误和尺寸不一致。
- 全黑 Mask 不调用模型，直接把原图保存为该工作流的结果；它可以保留在结果文件夹中，但比较 PDF 不为它建立页面。

Qwen 的节点 168 需要 masked RGBA 源图，不接受独立黑白 Mask 直接作为该节点输入。必须继续走 `runtime-tools/run_independent_edit_models_batch.py` 的 `qwenlanpaint` 路径：RGB 来自对应原图，需要修复的位置 Alpha 为 0。只验证输入、RGBA 构造和 Alpha 方向；不要对生成结果做内容质量阈值、自动筛除或拒绝。

FireRed 在 `FIRERED_LOAD_FLAT=1` 时，放到 `ComfyUI/input` 的平铺输入必须是实际文件，不能使用符号链接；ComfyUI 0.34 会把输入符号链接判为无效文件。

## 用户界面约定

- 创建任务使用三步向导：原图与 Mask → 修复流程 → 任务名称。
- 历史漫画修复批次显示在页面右栏；窄屏时可自然移到主内容下方。
- 文件夹模式自动用原图文件夹名填充任务名。
- 后端提交时统一追加 `_MMDD_HHMMSS`，例如 `第89话_0911_221530`。前端只展示提示，唯一命名逻辑必须留在后端。
- 运行期间隐藏整个设置向导，只显示进度、耗时、当前流程、已完成结果下载和经过二次确认的“放弃任务”。
- 刷新或关闭网页不能取消后台任务；重新打开后必须从后端恢复正在运行或最近查看的任务。
- 上传、重新提交和历史 ZIP 下载在 GPU 任务运行期间应保持锁定；已完成的中间结果可以下载。
- 历史成功任务需要保留结果目录和 ZIP 的服务器绝对路径，并提示大文件优先使用 SSH/SFTP，JupyterLab 作为备用。
- 已验证的时间基线与显存基线记录在 `docs/ARCHITECTURE.md`，不要把它们描述成所有硬件上的承诺。

## 任务和 API 约定

任务状态为：

```text
queued → validating → running → packaging → completed
   └──────────────→ abandoning → abandoned
                    └──────────→ failed
```

- 同一时间只允许一个 active job；建立新任务时发现已有 active job 应返回冲突。
- `GET /api/health`：应用、ComfyUI、队列、GPU 和显存状态。
- `POST /api/jobs`：上传两组文件并建立任务。
- `GET /api/jobs`：读取全部持久任务，供历史区和刷新恢复使用。
- `GET /api/jobs/{id}`：当前任务状态。
- `POST /api/jobs/{id}/abandon`：请求安全停止，保留已经同步的结果。
- `GET /api/jobs/{id}/download-current`：打包当前已完成结果。
- `GET /api/jobs/{id}/download`：下载最终 ZIP。
- 前端目前采用轮询：健康和任务列表约 3 秒一次，活动任务约 1 秒一次。若以后改为 SSE/WebSocket，仍必须保留磁盘状态和刷新恢复能力。

服务重启时，未完成的 `queued`、`validating`、`running`、`packaging` 任务会恢复进队列。不要仅凭子进程退出码判定完成；必须核对每个工作流的预期输出数量。

## 结果结构

任务工作目录位于：

```text
/root/autodl-tmp/comic-inpaint/jobs/<job-id>/
├── job.json
├── uploads/
├── inpaint_workflows/
├── logs/
└── download.zip
```

`inpaint_workflows/` 只创建用户实际选择的生产结果目录，名称必须是：

```text
inpaint_workflows/firered/
inpaint_workflows/qwen2511_lanpaint/
inpaint_workflows/flux2klein_lanpaint/
```

不要在这里放 `result_*`、`raw_*` 或临时下载目录。三套流程全部选择时，比较 PDF 直接放在 `inpaint_workflows/` 根目录，列顺序固定为：原图 + Mask、Flux2 Klein FP8 + LanPaint、FireRed FP8、Qwen Image Edit 2511 + LanPaint。日志只放在下载包顶层的 `logs/`。PNG 已经压缩，ZIP 以降低小文件传输开销为目标，不追求高压缩率。

## 本地开发与检查

首次安装：

```bash
npm --prefix frontend install
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt
```

修改后至少运行：

```bash
npm --prefix frontend run lint
npm --prefix frontend run build
.venv/bin/python -m pytest -q backend/tests
```

镜像结构检查：

```bash
make verify-local
```

`frontend/dist/` 是生成文件并被 Git 忽略。部署网页前必须先成功执行正式构建，再把新的 `dist/` 同步到服务器。不要提交 `.venv/`、`node_modules/`、测试缓存或本地运行目录。

只修改 Web UI、文案或不影响输入契约的 API 时，lint、build 和后端测试足够。只要修改了工作流、custom node、模型依赖、输入转换、Mask 方向或批次器，就必须在目标 GPU 上做真实回归；环境发生变化时先用一组非全黑 Mask 做 smoke test，已经固定且未变化的生产环境运行正式批次时不需要每次 smoke test。

行为或部署方式发生变化时，同时更新 `README.md`、`docs/ARCHITECTURE.md` 和 `docs/DEPLOYMENT.md` 中相关内容。

## 远端部署安全

部署前先读取 `/api/health`，确认 `active_job_id` 为 `null`。如果任务正在运行，不要覆盖代码、重启服务或切换模型。

- 只改前端或 FastAPI 时使用 `deploy/restart-web.sh`，它只能重启 6008；不要连带重启 6006。
- `deploy/start.sh` 会启动 6006 和 6008，只在确实需要同时启动完整服务时使用。
- 重启后检查 `/api/health`、新的前端资源名和进程；确认 6006 PID 没有因 6008 部署而改变。
- 不要在未经用户要求时启动、关闭或释放 AutoDL 实例。关机前确认任务结束、输出写盘并已按要求同步；释放实例是不可逆操作，必须再次核对目标实例和结果。
- 不要调用 AutoDL `/instance/pro/snapshot` 接口，它可能返回 root 密码、Jupyter Token 和 SSH 信息。当前 SSH 主机与端口不可用时，应让用户提供。
- AutoDL Developer Token 只能在执行时从系统钥匙圈读取，不能打印、写入仓库、命令日志或聊天。状态查询需检查 JSON 业务字段 `code`，不能只看 HTTP 状态。

## 镜像发布与机密清理

仓库和公开镜像不得包含：

- AutoDL Token、SSH 私钥、密码、Cookie、API Key、Jupyter Token；
- 用户上传图片、Mask、生成结果、PDF、ZIP；
- 任务 JSON、显存 CSV、运行日志、Shell 历史；
- 无关缓存和开发环境。

保存 AutoDL 镜像之前，先执行只读检查并查看精确目标：

```bash
./deploy/prepublish-clean.sh
```

只有确认目标无误且用户确实准备发布镜像时，才执行：

```bash
./deploy/prepublish-clean.sh --apply
```

然后运行 `deploy/verify.py`，确认 ComfyUI、custom nodes、工作流哈希、模型文件和前端构建完整。模型应通过 `config/models.json` 管理并链接到已确认的 AutoDL 公共库或持久盘；不要把大模型权重提交到 Git。

## 修改纪律

- 先阅读相关代码和文档，保持现有任务状态机、目录结构和生产参数。
- 保留用户已有修改；不要用破坏性 Git 命令覆盖工作树。
- 删除远端输入、输出、任务或镜像前必须明确核对范围。不要对 `/root`、`/root/ComfyUI` 或数据盘根目录执行宽泛递归删除。
- 不因诊断问题就自动修改服务；仅回答或分析时保持只读。
- 除非用户明确要求，不要自行提交、推送、开关机、发送外部通知或发布镜像。
- 完成修改后回报：改动文件、验证结果、是否部署、服务状态，以及仍需用户决定的事项。
