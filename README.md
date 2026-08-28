# ERP 票据助手

这是一个使用 Electron、Vue 3 和 TypeScript 开发的 ERP 辅助客户端。用户在内嵌 ERP 页面中手动登录，选择 PDF 或票据图片后，先在本地逐页预览并排除高敏页面，再由 Pi Agent 并发执行逐页 OCR 与字段标准化。每页完成后会立即合并并增量代填当前 ERP 新建页，全部保留页识别完成后结束。程序不会自动保存或提交表单。

当前链路仅使用 Electron 本地预处理、Pi Agent 和百炼模型接口，不需要启动或维护自建 OCR 后台服务。

## 已实现功能

- 在 Electron `WebContentsView` 中加载 ERP，保留 Cookie 和登录会话。
- 限制 ERP 导航到受信任域名，提供后退、前进和刷新。
- 使用模拟 JSON 验证“单位首营审批”新建页的 DOM 与网格代填。
- 支持上传 PDF、PNG、JPEG、BMP、TIFF 和 WebP。
- 使用 `pdfjs-dist` 和 `@napi-rs/canvas` 在 Electron 主进程中逐页渲染 PDF。
- 上传前在本地生成可放大的逐页预览，由用户排除身份证、护照、银行卡等高敏页面；被排除页不会调用任何模型。
- 使用 `@earendil-works/pi-ai` 注册 OpenAI 兼容的 Qwen OCR 与字段标准化模型。
- 每个并发页面请求使用隔离的 `@earendil-works/pi-agent-core` Agent 会话。
- 单页 OCR 完成后立即调用字段标准化模型，确定性校验通过后合并到累计结果并自动增量代填 ERP。
- 默认使用 8 路页面并发，所有用户保留页都会处理完成；并发结果按页码和字段证据合并。
- Agent 只暴露 `submit_unit_initial_approval` 业务工具，不具备 Shell、任意文件写入、数据库写入或 ERP 自动保存能力。
- 按 [`config/erp/unit-initial-approval.fields.json`](config/erp/unit-initial-approval.fields.json) 整理 32 个主表字段和 7 个资质明细字段。
- 对日期、页码、重复证照、敏感字段和关键缺失字段执行程序规则校验。
- 展示识别进度、逐页原文、缺失字段和人工复核提示。

## 运行架构

```text
用户选择 PDF / 图片
        │
        ▼
Electron 主进程
  ├─ 文件大小、格式、页数检查
  ├─ PDF.js + Canvas 生成本地逐页预览
  ├─ 用户排除高敏页（不发送模型）
  ├─ 仅将保留页转为 OCR JPEG
  └─ Pi Agent 并发页面流水线
       ├─ Qwen OCR：默认 8 路并发识别
       ├─ 单页字段标准化：调用 submit_unit_initial_approval
       ├─ TypeScript 规则校验与跨页累计合并
       └─ 串行增量代填 ERP，避免并发修改同一表单
        │
        ▼
全部用户保留页处理完成
        │
        ▼
用户核对 ERP 当前新建页并手动保存
```

“不需要后台服务”表示不再维护本项目自己的 OCR Web 服务，并不代表完全离线。PDF 预览和转页在本机完成；用户保留的页面图片与对应 OCR 文本会发送到配置的模型接口，用户排除的页面不会发送。若所有业务资料都不能离开内网，应将两个模型接口部署在内网，或切换回完整本地方案。

## 并发与自动代填行为

- `MAIN_VITE_PI_OCR_CONCURRENCY` 控制同时运行的页面流水线数量，默认值为 `8`。
- PDF 页面渲染按顺序排队；渲染完成的页面会立即进入并发 OCR，避免同一 PDF 文档并发重绘造成资源竞争。
- 每个页面独立执行 OCR 和字段标准化，完成顺序可能与页码不同；累计结果会按字段证据和资质唯一键合并。
- ERP 代填按完成顺序串行执行，避免多个页面同时修改同一表单。
- 系统不会按字段覆盖率提前结束；所有用户保留页都会识别完成。
- 自动代填只修改当前“单位首营审批”新建页，不会点击保存、提交或审批按钮。

开始识别前应先进入一个空白的“单位首营审批”新建页。识别期间不建议手工修改正在自动填充的字段；全部页面完成后，再对照原件核验并手动保存。

## 环境要求

- Windows 10/11
- Node.js `22.19.0` 或更高版本
- npm
- 一个支持图片输入的 OpenAI 兼容 OCR 接口
- 一个支持 Tool Calling 的 OpenAI 兼容字段标准化接口

## 安装

```powershell
git clone https://github.com/lihongfei1219/erp-plugins.git
Set-Location erp-plugins
npm install
Copy-Item .env.example .env
```

编辑根目录 `.env`，至少配置 ERP 地址、OCR 模型接口和标准化模型接口：

```dotenv
MAIN_VITE_ERP_URL=https://erp.example.com/Default.aspx
MAIN_VITE_PI_OCR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MAIN_VITE_PI_OCR_MODEL=qwen3.5-ocr
MAIN_VITE_PI_NORMALIZER_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
MAIN_VITE_PI_NORMALIZER_MODEL=deepseek-v4-flash-0731
```

模型名由实际供应商决定，示例名称不是强制值。接口地址应是 OpenAI 兼容 API 的根地址，通常以 `/v1` 结尾。

## 配置 API Key

API Key 只由 Electron 主进程读取，不通过 preload 暴露给 Vue，也不要使用 `MAIN_VITE_` 前缀。开发环境可以将下面一行加入已被 Git 忽略的本地 `.env`：

```dotenv
DASHSCOPE_API_KEY=your-api-key
```

`.env` 是明文文件，不能提交、分享或打包分发；生产环境更适合使用操作系统凭据或启动进程环境变量。

阿里云百炼上的两个模型共用一个 Key，推荐这样设置：

```powershell
$env:DASHSCOPE_API_KEY='your-api-key'
npm run dev
```

客户端仍兼容原来的通用 Key 名：

```powershell
$env:PI_API_KEY='your-api-key'
npm run dev
```

如果未来两个模型改用不同平台或不同 Key：

```powershell
$env:PI_OCR_API_KEY='your-qwen-api-key'
$env:PI_NORMALIZER_API_KEY='your-normalizer-api-key'
npm run dev
```

本地无鉴权接口可以不设置 Key。客户端会使用一个非敏感占位值满足 OpenAI SDK 的参数要求。

## 运行

启动 Electron 客户端：

```powershell
npm run dev
```

使用步骤：

1. 在内嵌 ERP 中手动登录。
2. 进入“购货首营管理 → 单位首营审批 → 新建”。
3. 点击“选择票据并筛选页面”，选择 PDF 或图片。
4. 在本地预览中查看或放大各页，取消勾选身份证、护照、银行卡、人脸证件照等高敏页面。
5. 确认保留页数后点击“开始识别”。
6. 客户端并发执行逐页 OCR；每页标准化完成后立即增量代填 ERP。
7. 客户端处理完全部保留页后结束。
8. 查看主表摘要、证照数量、缺失字段、复核提示和逐页原文，对照原件核验后再手动保存。

“使用模拟数据代填”仍可用于单独验证 ERP 页面定位，不需要模型接口。

## 关键配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `MAIN_VITE_PI_OCR_BASE_URL` | 无 | OCR OpenAI 兼容接口，Pi 模式必填 |
| `MAIN_VITE_PI_OCR_MODEL` | `qwen3.5-ocr` | OCR 模型 ID；默认上下文长度为 65536 |
| `MAIN_VITE_PI_NORMALIZER_BASE_URL` | OCR 地址 | 字段标准化接口 |
| `MAIN_VITE_PI_NORMALIZER_MODEL` | `deepseek-v4-flash-0731` | 支持 Function Calling 的字段标准化模型 |
| `MAIN_VITE_PI_MAX_UPLOAD_MB` | `100` | 最大文件大小 |
| `MAIN_VITE_PI_MAX_PAGES` | `50` | 最大 PDF 页数 |
| `MAIN_VITE_PI_OCR_CONCURRENCY` | `8` | 并发页面流水线数量 |
| `MAIN_VITE_PI_PAGE_TIMEOUT_MS` | `180000` | 单页 OCR 超时 |
| `MAIN_VITE_PI_NORMALIZATION_TIMEOUT_MS` | `180000` | 字段标准化超时 |
| `DASHSCOPE_API_KEY` | 无 | 阿里云百炼 Key，默认同时供两个模型使用 |
| `PI_API_KEY` | 无 | 兼容的通用共用 Key |
| `PI_OCR_API_KEY` | 无 | OCR 专用 Key，优先于共用 Key |
| `PI_NORMALIZER_API_KEY` | 无 | 标准化模型专用 Key，优先于共用 Key |

## 项目结构

```text
src/
├─ main/
│  ├─ agent/
│  │  ├─ config.ts                       # Pi 运行时配置
│  │  ├─ document-images.ts              # PDF/图片本地预处理
│  │  ├─ incremental-extraction.ts       # 跨页字段合并与覆盖率统计
│  │  ├─ model-registry.ts               # Pi 模型与 Provider 注册
│  │  ├─ pi-document-client.ts            # 并发页面流水线与增量代填编排
│  │  └─ unit-initial-approval-tool.ts    # 字段 Schema、提交工具与规则校验
│  ├─ document-extraction-client.ts       # 文档提取接口与增量更新类型
│  ├─ extraction-client-factory.ts        # Pi 文档客户端初始化与配置错误隔离
│  ├─ page-selection.ts                   # 排除页码校验
│  ├─ erp-autofill.ts                     # ERP DOM 与网格代填
│  └─ erp-view.ts                         # ERP WebContentsView 控制
├─ preload/                               # 受限 IPC 桥接
├─ renderer/                              # Vue 界面
└─ shared/                                # 主进程与渲染进程共享类型
config/erp/unit-initial-approval.fields.json
docs/ocr-license-processing-architecture.md
```

## 验证命令

```powershell
# TypeScript 与 Vue 类型检查
npm run typecheck

# Electron 生产构建
npm run build

# OCR 重复结束原因与排除页码单元测试
npm run test:ocr-recovery

# 跨页字段合并与覆盖率统计单元测试
npm run test:incremental-extraction

# 安全输入一个百炼 Key，依次验证 Qwen OCR 与 DeepSeek Function Calling
npm run test:bailian-models:prompt
```

## 安全边界

- ERP 登录由用户手动完成，仓库中不保存账号或密码。
- API Key 仅存在于 Electron 主进程环境，不进入 renderer 或 preload API。
- 原始本地文件路径不会暴露给 renderer；页面筛选使用一次性令牌。
- 页面预览只在本机生成，被用户排除的页面不会调用 Qwen OCR，也不会进入字段标准化模型。
- Pi Agent 不暴露 Shell、任意文件读写、数据库写入、浏览器操作或 ERP 保存工具。
- Agent 的唯一业务工具只接收受 TypeBox Schema 约束的首营字段。
- ERP 增量代填由用户点击“开始识别”触发，代填后仍须人工核验和手动保存。
- `.env`、原始 PDF、真实业务 JSON、模型缓存和临时文件已在 `.gitignore` 中忽略。
- 使用外部模型接口会传输业务资料；生产部署前必须确认数据驻留、日志保留和供应商合规要求。

## 许可证提示

当前客户端链路使用的 Pi 包为 MIT，`pdfjs-dist` 为 Apache-2.0，`@napi-rs/canvas` 为 MIT。正式分发前仍应按实际依赖版本和部署方式完成一次完整的第三方许可证审查。
