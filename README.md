# ERP 票据助手

> 内部工具 · Created by lff · Copyright © 2026

这是一个使用 Electron、Vue 3 和 TypeScript 开发的 ERP 辅助客户端。可预设账号密码，启动时为本地保存的每个账号打开一个独立窗口并分别登录，也支持手动登录。客户端自动识别当前受支持的业务新建页。单位首营先在本地逐页预览并筛选；采购订单和商品收货登记支持一次选择多个图片或 PDF 文件，选完直接进入后台识别队列，每个文件独立形成一张票据。Pi Agent 执行逐页 OCR 与当前业务专属的字段标准化。每张票据完成后即可人工复核和代填；程序不会自动保存、提交或审核表单。

当前链路仅使用 Electron 本地预处理、Pi Agent 和百炼模型接口，不需要启动或维护自建 OCR 后台服务。

## 已实现功能

- 在 Electron `WebContentsView` 中加载 ERP，保留 Cookie 和登录会话。
- 账号管理支持本机加密保存密码、启动时按本地账号数量自动打开窗口并分别登录，不设固定账号或窗口数量上限；各账号 Cookie、票据会话、进度和代填互相隔离。
- 限制 ERP 导航到受信任域名，提供后退、前进和刷新。
- 支持“单位首营审批”、“商品收货登记”和“采购订单”三个隔离的业务适配器。
- 根据 ERP 页面的 `Ename + Cname + Mode` 自动选择业务，不允许跨业务使用识别结果或测试数据。
- 支持上传 PDF、PNG、JPEG、BMP、TIFF 和 WebP。
- 支持从本机文件夹将图片或 PDF 拖到助手区或 ERP 表单区：采购与收货直接进入当前业务的批量队列；单位首营每次拖入一个文件后进入原有筛页流程。拖拽不触发自动代填或保存。
- 使用 `pdfjs-dist` 和 `@napi-rs/canvas` 在 Electron 主进程中逐页渲染 PDF。
- 单位首营上传前在本地生成可放大的逐页预览，由用户排除高敏页面；采购订单和商品收货登记取消上传前筛页，选择的文件全部进入识别。
- 采购与收货批量任务按账号、工作窗口和业务隔离，原图副本与结果仅在当前窗口生命周期内缓存。一张完成就可代填，其余继续识别；同一窗口内新建单据可直接使用待处理结果，关闭工作窗口后全部清空。
- 使用 `@earendil-works/pi-ai` 注册 OpenAI 兼容的 Qwen OCR 与字段标准化模型。
- 每个并发页面请求使用隔离的 `@earendil-works/pi-agent-core` Agent 会话。
- 所有业务的 OCR、补识别和字段标准化均显式关闭深度思考；旧思考开关不再生效。
- 单页 OCR 完成后调用当前业务专属的字段标准化工具，确定性校验通过后合并到当前会话。
- 默认使用 8 路页面并发，所有用户保留页都会处理完成；并发结果按页码和字段证据合并。
- 每个 Agent 只暴露当前业务的提交工具：`submit_unit_initial_approval`、`submit_goods_receipt` 或 `submit_purchase_order`。
- 按 [`config/erp/unit-initial-approval.fields.json`](config/erp/unit-initial-approval.fields.json) 整理 32 个主表字段和 7 个资质明细字段。
- 采购订单会区分销售方与收货客户，并按票据原始行逐条保留商品；相同商品、批号和单价也不会合并。
- 采购订单的小字图片放大至最多三倍（最长边 2600 像素），使用 PNG 避免二次有损压缩。低分辨率或商品字段不完整的横向单据会核对左右重叠区域，补全商品名称、厂家及换行日期，合并到原商品行；缺失抬头时单独补识别表头。
- 采购订单首次字段整理后，按整份文件所有已选页的商品明细汇总判断：商品名称、规格、厂家、批准文号、单位、数量、含税单价、批号、生产日期和有效期这 10 类字段的总缺失率达到 50%（含），或完全没有商品明细，触发一轮商品区域放大补识别。单行缺失率不单独触发，表头字段不计入。优先定位表格，定位不可靠时使用保留上下文的重叠区域；每页最多两次局部 OCR、一次字段整理，补救限时 30 秒。只补缺失值，行数或对应关系冲突时保留首次结果并提示核对；不会循环重试，也不会替代 ERP 商品参照匹配。
- 对日期、页码、重复证照、敏感字段和关键缺失字段执行程序规则校验。
- 展示识别进度、字段到 ERP 的映射、商品/证照明细、逐页原文和人工复核提示。
- 每次文件选择生成独立的 `sessionId`，文件令牌、识别结果和代填请求均绑定 `sessionId + businessId`。

## 运行架构

```text
用户选择 PDF / 图片（采购订单、商品收货登记支持多选）
        │
        ▼
Electron 主进程
  ├─ 文件大小、格式、页数检查
  ├─ 单位首营：本地逐页预览，筛选保留页
  ├─ 采购/收货：每文件独立入队，缓存原图，直接识别全部页面
  ├─ 按业务生成 OCR JPEG / PNG
  └─ Pi Agent 并发页面流水线
       ├─ Qwen OCR：默认 8 路并发识别
       ├─ 按当前业务调用独立字段标准化工具
       ├─ TypeScript 规则校验与跨页累计合并
       └─ 将结果写入隔离的业务会话
        │
        ▼
单份结果完成后复核字段与明细（采购订单其余任务继续后台识别）
        │
        ▼
点击“确认并代填” → 核对 ERP → 手动保存
```

“不需要后台服务”表示不再维护本项目自己的 OCR Web 服务，并不代表完全离线。PDF 预览和转页在本机完成；首营中用户保留的页面、采购与收货队列中所选文件的全部页面，以及对应 OCR 文本会发送到配置的模型接口。若所有业务资料都不能离开内网，应将两个模型接口部署在内网，或切换回完整本地方案。

## 并发、复核与代填行为

- OCR 与标准化在所有窗口之间共享调度器。`MAIN_VITE_PI_OCR_CONCURRENCY` 控制 OCR 阶段并发，默认 `8`；`MAIN_VITE_PI_MODEL_CONCURRENCY` 控制合计并发，默认沿用 OCR 并发；`MAIN_VITE_PI_NORMALIZER_CONCURRENCY` 控制标准化并发，默认取 `4` 和合计上限的较小值。
- PDF 页面渲染按顺序排队；渲染完成的页面会立即进入并发 OCR，避免同一 PDF 文档并发重绘造成资源竞争。
- 每个页面独立执行 OCR 和字段标准化，完成顺序可能与页码不同；累计结果会按字段证据和资质唯一键合并。
- 系统不会按字段覆盖率提前结束；所有用户保留页都会识别完成。
- 识别期间不会修改 ERP。识别完成后必须由用户确认，主进程会再次校验当前页面、业务和会话。
- 单位首营、商品收货和采购订单分别使用独立 Schema、提示词、合并规则、测试数据和代填脚本。
- 商品收货图片以两倍尺寸生成 OCR JPEG（最长边仍限制为 2600 像素），并明确识别表格外的公司抬头、单号和合计。票面“数量”进入到货数量，实际收货数量仅在票据明确提供时提取；缺失的承运信息留待人工补充。
- 商品收货图片和 PDF 的每个保留页，在 OCR 漏读抬头、单号或发货日期时，会额外对该页顶部四分之一区域执行一轮补识别（沿用最多两次 OCR 尝试）。补充内容仅用于基本信息，不重复添加明细；跨页商品按原始行保留并按页码排序。
- 任何代填都不会点击保存、提交或审批按钮。

开始识别前应先进入受支持业务的空白新建页。切换到另一业务后，工作台会解除当前会话绑定，不会展示或使用上一业务的数据。

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

`.env` 是明文文件，不能提交或单独分享。当前内部发行构建会在编译阶段只把
`DASHSCOPE_API_KEY` 写入 Electron 主进程产物，不会把 `.env` 文件本身放入安装包，
也不会把 Key 写入 renderer 或 preload。运行时环境变量仍具有更高优先级，可用于临时覆盖内置 Key。

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

单位首营审批的使用步骤（采购订单、商品收货登记见下文“采购与收货批量队列”）：

1. 首次启动在“账号管理”中保存账号备注、用户名和密码，点击“打开全部账号”；以后启动会自动打开本地保存的全部账号，也可点击“手动登录窗口”沿用原来的登录方式。
2. 进入任一已支持的新建页：“购货首营管理 → 单位首营审批”、“商品收货管理 → 商品收货管理”或“采购业务管理 → 采购订单管理”。
3. 单位首营点击“选择票据并筛选页面”，选择 PDF 或图片。采购订单和商品收货登记使用下文的批量队列流程。
4. 在本地预览中查看或放大各页，取消勾选身份证、护照、银行卡、人脸证件照等高敏页面。
5. 确认保留页数后点击“开始识别”。
6. 客户端并发执行逐页 OCR，并仅使用当前业务的 Schema 完成字段标准化。
7. 处理完成后，在右侧工作台核对基本字段、证照或商品明细及异常提示。
8. 点击“确认并代填”，再在 ERP 中核验并手动保存。

### 多账号窗口

- 所有预设账号使用 `.env` 中同一个 ERP 地址。已适配当前 `Login.aspx` 的 `tbUser`、`tbPassword`、`btnLogin`；自动登录只向配置的登录源与路径填写密码，并使用原页面表单提交。
- 本地保存几个账号，启动时就打开几个工作窗口；可通过添加、删除账号调整数量，不再限制为四个。旧版配置中的启动勾选状态不再参与筛选，已保存的账号均会打开。没有保存账号时进入账号管理。
- 每个账号最多打开一个工作窗口，再次打开已有账号会切换到对应窗口。窗口标题及顶部显示账号备注和用户名。
- 登录状态有效时直接进入 ERP，过期后自动登录。账号密码错误时只尝试一次，修改配置后可重新打开；页面上的“重新登录”也可恢复一次登录尝试。用户主动点击退出后暂停自动登录。
- 在工作窗口顶部点击“账号管理”可添加、编辑和删除账号。编辑或删除前须先关闭该账号窗口。编辑时密码留空表示保留原密码；修改用户名或 ERP 地址必须重新输入密码。
- 账号资料写入 Electron 用户数据目录的 `accounts.json`。密码由 Windows DPAPI（Electron `safeStorage`）加密，仅在自动登录时解密；不支持将加密文件直接复制到另一 Windows 用户后继续使用。此加密不防护同一 Windows 用户下的其他进程。
- 账号采用独立持久化浏览器分区，删除账号时清除对应登录存储；修改用户名或 ERP 源会使用不同分区。原手动登录分区继续保留，不能自动转换成预设账号。
- 工作窗口实际关闭后，清理该窗口的首营会话、采购与收货队列，取消进行中的识别并删除缓存副本和结果；重新打开该账号窗口从空队列开始，不影响其他窗口。取消关闭操作则保留数据。窗口尺寸和位置按账号保存；“排列工作窗口”会在空间足够时平铺，空间不足时层叠排列。
- 首次使用真实账号时应核对 ERP 登录后的身份。自动登录失败可在原 ERP 页面手动完成；识别到账号身份不一致时会阻止代填。

退出账号、刷新或跳转时，如果 ERP 的离开前检查阻止了操作，客户端会显示“确认离开 ERP 页面”。选择“离开页面”继续操作；选择“留在当前页面”或关闭确认框则保留当前页面，以便先保存单据。

单位首营的识别结果仍暂存在当前 ERP 单据页的内存会话中。代填完成后，若误删了字段或证照行，可点击“重新代填”复用识别结果，无需再次调用 OCR 或标准化模型。切换到其他单据页再切回来仍可使用；关闭、刷新该单据页或关闭客户端后自动清除。同一业务的新单据页不会继承旧页结果。

### 采购与收货批量队列

在账号管理中保存账号并打开对应工作窗口，进入采购订单或商品收货登记页面，点击“批量选择图片并识别”。适用于使用相应业务的所有已保存账号。可以多选图片或 PDF；选择完成即开始识别，不再出现上传前勾选页面和二次开始按钮。每个图片文件对应一张票据，单个多页 PDF 对应一张票据；同一单据的多张照片请先合为一个 PDF。单位首营审批保持原来的筛页与识别流程。

也可以在目标业务的新建页面中，从本机文件夹一次拖入多张图片或 PDF，松开即导入，无需打开文件选择框。助手区与 ERP 表单区均可接收拖拽；无效格式、文件夹及超出大小限制的文件逐个报错，其余有效文件继续处理。切换业务或账号后不能复用上一窗口的拖入请求。单位首营只接收单个文件，仍须筛选并点击“开始识别”。每次最多拖入 500 个文件；导入、代填或预览尚未结束时，请完成当前操作后再拖入。

- 队列最多同时处理两个文件，复用应用共享的 OCR/标准化模型并发预算。先完成的结果立即可用，不必等待整批结束；某张失败只需重试该张。
- 票据队列保持导入顺序。后台结果更新不会切换正在复核的票据。每张结果都可查看原图、字段、商品和 OCR 原文。
- 新建空白采购订单或收货单时，助手推荐当前业务下一张尚未代填的可用结果。切换业务仅展示该业务的队列，采购结果不能用于收货，收货结果不能用于采购。确认代填时才绑定具体单据页；已有供应商、商品内容或已绑定其他票据的单据不会被新票据覆盖。
- “已代填”只表示字段写入成功，仍需在 ERP 核对并保存。部分失败保留同页重试能力；已代填及异常中断记录不会自动重新放入待处理。需要再次制单时，先核对 ERP、关闭原单据页，再点击“重新放入待处理”。
- 原图副本、完整结果及状态在 Electron `userData/purchase-queue` 下按工作窗口临时缓存。窗口内切换、新建、关闭或刷新 ERP 单据页，不删除队列；刷新助手界面或助手渲染进程重载也可继续使用当前窗口的数据。
- 关闭工作窗口会取消未完成识别、删除全部队列任务（含已识别和已代填记录）及缓存原图；保留用户原始文件和 ERP 已保存单据。再次打开同一账号使用全新的队列身份，迟到的旧请求不会恢复数据。退出整个客户端后同样不恢复；下次启动清理异常退出及旧版本留下的缓存，文件暂被占用时下次启动重试清理，残留文件不会被新窗口使用。
- 批量队列仍需从账号管理打开已保存的账号窗口。窗口内退出登录会暂停识别，重新登录后可继续；关闭工作窗口则清空，不跨窗口保留。
- 可以取消待处理任务、重试失败任务，或删除不再需要且未绑定单据页的缓存票据。

“使用模拟数据代填”仍可用于单独验证 ERP 页面定位，不需要模型接口。

采购订单的离线测试数据来自 [`test-data/purchase-order.example.json`](test-data/purchase-order.example.json)。队列代填会先走 ERP 供应商参照，再按商品名称、规格、生产厂商和批准文号匹配商品参照，最后填写数量和含税单价并等待 ERP 重算金额。匹配不唯一时会停止该行代填并要求人工选择，不会写入猜测的内部编号。

商品收货的识别结果与模拟数据共用同一个代填入口和字段映射：复用对应商品行或空行，不足时通过 `gridhandler('add', 'B')` 新增，再通过单元格 `setValue` 填写商品名称、规格、厂家、单位、单价、批号、日期及数量。不再以供应商/商品参照成功作为新增明细的前提。重复商品按票据行保留，多页 PDF 使用相同的逐行填充流程；重试复用已填写的对应行，不覆盖无关商品。

商品编号与供应商编号不由 OCR 生成；已有 ERP 商品编号的行保留其主数据、订单数量和价格。票据缺少实际收货数量时保持原值，包装数量不会写成订单数量。代填只写入当前页面，仍需在 ERP 核对关联信息并手动保存；字段写入失败会显示未填原因，避免仅填表头就显示整单完成。

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
│  │  ├─ pi-document-client.ts            # 并发页面 OCR 与业务标准化编排
│  │  └─ unit-initial-approval-tool.ts    # 字段 Schema、提交工具与规则校验
│  ├─ businesses/
│  │  ├─ extraction-registry.ts           # 业务提取适配器注册中心
│  │  ├─ goods-receipt-tool.ts            # 商品收货 Schema、工具和规则
│  │  ├─ purchase-order-tool.ts           # 采购订单 Schema、原始行保留和校验
│  │  └─ page-registry.ts                 # ERP 页面业务识别
│  ├─ workflow-session-manager.ts         # 文件令牌与识别结果会话隔离
│  ├─ window-manager.ts                   # 多窗口生命周期、按来源分发 IPC 和窗口排列
│  ├─ account-store.ts                    # 账号配置与加密密码存储
│  ├─ erp-login.ts                        # 当前 ERP 登录页适配、登录状态和退出处理
│  ├─ workflow-ipc.ts                     # 每个窗口独立的 OCR 与代填 IPC
│  ├─ document-extraction-client.ts       # 通用文档提取接口
│  ├─ extraction-client-factory.ts        # Pi 文档客户端初始化与配置错误隔离
│  ├─ page-selection.ts                   # 排除页码校验
│  ├─ erp-autofill.ts                     # ERP DOM 与网格代填
│  └─ erp-view.ts                         # ERP WebContentsView 控制
├─ preload/                               # 受限 IPC 桥接
├─ renderer/                              # Vue 界面
└─ shared/                                # 主进程与渲染进程共享类型
config/erp/unit-initial-approval.fields.json
config/erp/goods-receipt.fields.json
config/erp/purchase-order.fields.json
test-data/purchase-order.example.json
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

# 单位首营跨页字段合并与覆盖率统计单元测试
npm run test:incremental-extraction

# 页面识别、文件令牌和识别结果跨业务隔离测试
npm run test:business-isolation

# 账号配置、密码存储边界、任意账号数量与旧配置兼容
npm run test:accounts

# 先 build，再运行使用本地模拟 ERP 的 Electron 多窗口测试（不调用外部模型）
npm run test:multi-account

# 采购订单原始行保留、跨页拼接与金额校验测试
npm run test:purchase-order

# 采购批量队列、账号隔离、本地恢复和代填占用测试（离线）
npm run test:purchase-queue

# 先 build；真实客户端界面与本地模拟 ERP 的批量操作测试（离线）
npm run test:purchase-queue:electron

# 商品收货批量识别、跨业务隔离及原单位首营流程回归（先 build，离线）
npm run test:goods-queue:electron
npm run test:queue-lifetime:electron
node scripts/run-multi-account-test.mjs session-cache
npm run test:file-drop:electron

# 使用本地已授权的真实票据验证采购订单（显式联网，发送票据到配置的百炼接口）
# 需自行准备 test-data/purchase-order.receipts.json 及其 sourceImage；真实验收数据不随公开仓库分发。
npm run test:purchase-order:document

# 模拟首次整理缺失 7 个商品字段，实际调用百炼验证放大补救（独立保存结果）
npm run test:purchase-order:document -- --simulate-missing-products

# 使用指定的 CKFH26070523 原图验证商品收货完整识别链路（会调用配置的外部模型）
npm run test:goods-receipt:document

# 同一原图生成三页 PDF，排除第二页，验证另外两页的识别与合并
npm run test:goods-receipt:document -- --pdf

# 本地图片预处理测试（使用同一原图，不调用模型）
npm run test:document-images

# 安全输入一个百炼 Key，依次验证 Qwen OCR 与 DeepSeek Function Calling
npm run test:bailian-models:prompt
```

商品收货原图测试使用根目录 `f1be425b3289565524cce105c39875d5.png`，校验供应商、发货日期、单号、每页七条原始商品行、数量和合计金额，以及是否可进入确认代填。图片结果写入被 Git 忽略的 `tmp/goods-receipt-document/result.json`，PDF 结果写入同目录的 `result-pdf.json`。该命令会发送此票据及 OCR 文本到 `.env` 配置的模型接口，不操作 ERP；普通单元测试不会调用模型。

## 安全边界

- ERP 可使用本机加密保存的预设密码自动登录，也可手动登录。仓库中不保存真实账号或密码，账号管理只返回公开资料，不返回已保存的密码。
- API Key 仅进入 Electron 主进程构建和运行环境，不进入 renderer 或 preload API。
- 原始本地文件路径不会暴露给 renderer；页面筛选使用一次性令牌。
- 页面预览只在本机生成。单位首营中被排除的页面不发送模型；采购订单和商品收货登记选择文件后直接识别其中全部页面，原图查看仅用于复核。
- Pi Agent 不暴露 Shell、任意文件读写、数据库写入、浏览器操作或 ERP 保存工具。
- 每个 Agent 只能调用当前业务注册的 TypeBox 工具，模型返回的其他业务结构不会进入会话。
- ERP 代填由用户点击“确认并代填”触发，代填后仍须人工核验和手动保存。
- `.env`、原始 PDF、模型缓存和临时文件已在 `.gitignore` 中忽略。提交测试数据前仍须人工确认是否需要脱敏。
- 使用外部模型接口会传输业务资料；生产部署前必须确认数据驻留、日志保留和供应商合规要求。

## 许可证提示

当前客户端链路使用的 Pi 包为 MIT，`pdfjs-dist` 为 Apache-2.0，`@napi-rs/canvas` 为 MIT。正式分发前仍应按实际依赖版本和部署方式完成一次完整的第三方许可证审查。
