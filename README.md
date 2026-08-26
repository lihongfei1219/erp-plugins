# ERP 票据助手

一个基于 Electron、Vue 3 和 TypeScript 的桌面 ERP 辅助客户端。客户端在独立的浏览器视图中打开 ERP，由用户手动登录并进入业务页面，然后将结构化票据数据代填到当前表单。

项目目前已完成“单位首营审批”新建页的模拟数据代填，OCR 上传与识别仍在规划中。

## 当前功能

- 在 Electron `WebContentsView` 中加载 ERP 网站。
- 保留 ERP Cookie 和登录会话，登录操作由用户手动完成。
- 提供后退、前进、刷新和加载状态提示。
- 识别“单位首营审批”的新建页面，避免向错误页面填入数据。
- 一键填写单位名称、营业执照、地址、银行账户、联系人等基础字段。
- 调用 ERP 原有网格接口，自动新增并填写多条证照资料。
- 显示成功填写数量和跳过字段，不自动保存或提交。
- 限制页面跳转域名、禁用 Node.js 注入和网页权限请求。

## 技术栈

- Electron 44
- Vue 3
- TypeScript 5
- electron-vite 5
- Vite 7

## 环境要求

- Node.js 22（当前开发环境使用 `v22.22.0`）
- npm 10 或兼容版本
- Windows 10/11（当前主要测试平台）

## 快速开始

克隆并安装依赖：

```bash
git clone https://github.com/lihongfei1219/erp-plugins.git
cd erp-plugins
npm install
```

复制环境变量模板：

```powershell
Copy-Item .env.example .env
```

编辑 `.env`，填写 ERP 登录页地址：

```dotenv
MAIN_VITE_ERP_URL=https://erp.example.com/Default.aspx
```

如果登录流程会跳转到独立的 SSO 域名，将其加入允许列表；多个域名使用英文逗号分隔：

```dotenv
MAIN_VITE_ALLOWED_ORIGINS=https://sso.example.com,https://auth.example.com
```

启动开发环境：

```bash
npm run dev
```

## 使用代填功能

1. 启动客户端，在内嵌 ERP 页面中手动登录。
2. 进入“购货首营管理 → 单位首营审批”。
3. 点击 ERP 页面中的“新建”。
4. 点击客户端右侧的“使用模拟数据代填”。
5. 核对所有字段和证照明细。
6. 确认无误后，由用户手动点击 ERP 的“保存”。

代填按钮不会自动保存或提交表单。

## 页面定位方式

客户端使用结构化标识定位页面和字段，不依赖屏幕坐标或视觉位置：

- 根据受信任域名、`/ZhiDan/ZhiDan.aspx` 路径和 `Type=Add` 参数定位新建页 iframe。
- 根据页面标题以及 `DWMC`、`YYZZH` 等关键元素确认表单类型。
- 使用 ERP 固定字段 ID 填写基础字段。
- 使用 ERP 页面提供的 `gridhandler` 和 `gridEditBody` 接口填写证照明细。
- 下拉框会先检查选项是否存在；异步新增明细行最多等待 10 秒。

如果 ERP 升级后修改页面路径、字段 ID 或网格接口，需要同步更新 `src/main/erp-autofill.ts` 和 `src/main/erp-view.ts` 中的适配逻辑。

## 模拟数据与隐私

仓库中的 [`test-data/unit-initial-approval.example.json`](test-data/unit-initial-approval.example.json) 是完全虚构的开发示例，不对应任何真实个人或企业。

以下内容已通过 `.gitignore` 排除，请勿提交到代码仓库：

- `.env` 和本地环境配置。
- 原始 PDF、票据扫描件和盖章文件。
- 从真实业务资料中提取的原始 JSON。
- ERP 账号、密码、身份证号、银行账户等敏感信息。

如需使用本地真实数据，请在本机维护独立文件，并在发布代码前再次检查 Git 暂存区。

## 项目结构

```text
src/
├─ main/
│  ├─ index.ts          # Electron 主进程和 IPC 注册
│  ├─ erp-config.ts     # ERP 地址和允许域名配置
│  ├─ erp-view.ts       # ERP WebContentsView 与页面定位
│  └─ erp-autofill.ts   # 模拟数据映射和表单代填
├─ preload/
│  └─ index.ts          # 安全暴露给渲染进程的 API
├─ renderer/
│  └─ src/              # Vue 客户端界面
└─ shared/
   └─ erp.ts            # 主进程和渲染进程共享类型
test-data/
└─ unit-initial-approval.example.json
```

## 开发命令

```bash
# 启动开发环境
npm run dev

# TypeScript / Vue 类型检查
npm run typecheck

# 类型检查并生成生产构建
npm run build

# 预览生产构建
npm start
```

构建产物会生成在 `out/`，该目录不会提交到 Git。

## 后续计划

- 上传图片或 PDF 票据。
- 接入 OCR 服务并生成统一结构化数据。
- 增加 OCR 结果预览、置信度和人工校正。
- 将页面字段映射抽成可配置适配器。
- 增加 ERP 页面版本指纹检测和自动化回归测试。
- 增加 Windows 安装包和自动更新能力。
