# 个人记账应用

[English](README.md) | **中文**

> Build With AI: Basics 参赛作品 · 一个在手机浏览器里使用、零服务费用的个人记账网页

把实体店付款和外卖订单汇入同一本账，区分不同兼职的收入来源，并按月展示“钱花在哪里、从哪里来”。识别失败的交易不会被丢掉，而是标为“待补全”，等你回来补上。

账本就是你自己 Google 账号里的一张 Google 表格，程序运行在 Google Apps Script 上：不需要服务器、不需要数据库软件、不绑定任何付款方式。

## 功能

| 状态 | 功能 |
| --- | --- |
| ✅ 已上线 | 记一笔／编辑／删除（“最近删除”30 天内可恢复） |
| ✅ 已上线 | 退款：记为负支出并关联原交易，按退款日期归月 |
| ✅ 已上线 | 收入的具体来源（如“兼职 A”“兼职 B”），可重复选择 |
| ✅ 已上线 | 待补全：金额无法识别的交易照常显示并提醒，补填前不计入合计 |
| ✅ 已上线 | 月报：支出构成、收入构成（可展开来源）、同月收支对比 |
| ✅ 已上线 | 按美国东部时间（America/New_York）归属月份，不受手机时区影响 |
| ✅ 已上线 | 薄荷绿柔和界面；两步记账（选类别 → 自带数字键盘输入金额） |
| ✅ 已上线 | 每月总预算与类别预算；圆环报表；月账单与年账单 |
| ✅ 已上线 | “我的”页打卡：连续／累计天数与里程碑 |
| ✅ 已上线 | 左上角规则式小猫助手：预算提醒、夸奖、超支速度、5 个问题按钮；“去处理”可逐月查看待处理账目 |
| ✅ 已上线 | 实体店 Apple Pay 自动入账（iPhone 快捷指令 → 收件口 → 账本），读不到金额时标为待补全 |
| ✅ 已上线 | Gmail 收据自动入账：DoorDash、Uber Eats（餐饮）与 Uber 打车（交通）；名单外像收据的邮件进入“待查看邮件”，可记一次、加入名单、静音或标记已查看 |
| ✅ 已上线 | 跨入口疑似重复提示（如 Apple Pay 与外卖收据同一笔） |
| ✅ 已上线 | 按日期范围生成收支交易表格（独立 Google 表格，可下载 Excel） |
| ✅ 已上线 | 储蓄目标；消费习惯（本月与上月同期、最近 3 个月类别变化） |
| ✅ 已上线 | 界面中英文切换：“我的 → 语言”，记在本机浏览器；默认类别跟着切换，自建内容保持原样 |
| 🤔 待决定 | 在手机上更像 App 的打开方式（主屏幕全屏图标） |

## 工作原理

```
iPhone Safari ──登录 Google（只有本人可访问）──▶ 记账-主程序（Apps Script 网页应用）
                                                   │  读写
                                                   ▼
                                             「账本」Google 表格
Gmail 收据 ──每 5 分钟只读检查──▶ 记账-主程序
Apple Pay 快捷指令 ──口令保护──▶ 记账-收件口 ──▶「收件箱」表格 ──每 5 分钟整理──▶ 记账-主程序
```

- **费用：** 只使用 Apps Script 与 Google 表格的个人免费额度；从不绑定结算账户。
- **隐私：** 网页只允许你本人登录访问；账目只存在你自己的 Google 表格里，不发送给任何第三方服务。
- **金额：** 全部以整数“美分”计算，避免小数误差。

## 快速开始（部署到你自己的 Google 账号）

完整的图文步骤见 [`docs/setup-guide.md`](docs/setup-guide.md)。概要：

1. 开启 Google 账号两步验证。
2. 新建「账本」表格，在其中通过 **扩展程序 → Apps Script** 创建项目「记账-主程序」。
3. 在 Apps Script 的**用户设置**中打开 “Google Apps Script API”。
4. 本机安装依赖并登录 clasp（授权页面请勾选全部权限）：
   ```bash
   npm install
   npx clasp login
   ```
5. 复制 `apps/main/.clasp.json.example` 为 `apps/main/.clasp.json`，填入脚本 ID（该文件已被 git 忽略）。
6. 上传代码（**在 `apps/main` 目录内运行**）：
   ```bash
   cd apps/main
   npx clasp push
   ```
7. 在脚本编辑器中运行 `setupLedger`（创建工作表与默认类别，首次需授权）。
8. **Deploy → New deployment → Web app**：Execute as **Me**，Who has access **Only myself**。
9. 运行 `installTriggers`（每日清理“最近删除”中超过 30 天的账目，并每 5 分钟整理 Apple Pay 收件箱）。
10. 在 iPhone Safari 打开网页应用地址，**分享 → 添加到主屏幕**。

两个自动入口都是可选的，没开启也不影响手动记账：

- **Apple Pay**：按 [`docs/applepay-setup.md`](docs/applepay-setup.md) 部署「记账-收件口」（`apps/inbox`），再按 [`docs/shortcut-setup.md`](docs/shortcut-setup.md) 设置 iPhone 快捷指令。
- **Gmail 收据**：按 [`docs/gmail-receipts-setup.md`](docs/gmail-receipts-setup.md) 先运行只读试运行 `dryRunReceipts` 核对识别结果，再运行 `enableReceiptPolling` 开启每 5 分钟的轮询。

部署后可按 [`docs/checklist-slice1.md`](docs/checklist-slice1.md) 在手机上逐项验收。

## 开发

需要 Node.js（在 v25 上开发）。运行时**没有第三方依赖**；开发依赖只有 `@google/clasp`（上传代码）和 `jsdom`（模拟浏览器的界面测试）。

```bash
npm install
node --test tests/                        # 全部测试，不联网、不需要登录
npm run check:i18n                        # 检查英文对照表是否覆盖所有界面文字（约 1 分钟）
cd apps/main && npx clasp show-file-status   # 查看将要上传的文件
```

测试会把 `apps/main` 下的代码放进同一个全局作用域运行（与 Apps Script 的加载方式相同），Google 服务用模拟对象代替；`tests/ui.test.js` 在模拟浏览器里打开真实网页，像用户一样点击。

### 文件结构

```
apps/main/                 记账-主程序（clasp 从这里上传）
  appsscript.json          时区、V8、权限清单、网页仅本人访问
  web.js                   网页入口与网页可调用的 api_* 函数（写操作加锁）
  store.js                 Google 表格读写（防止文字被自动转换为日期或公式）
  gmail.js                 Gmail 读取（只读）
  jobs.js                  setupLedger / installTriggers / processInbox / pollReceipts / dryRunReceipts / enableReceiptPolling 等
  core/                    纯逻辑：金额、时区、月报、预算、小助手、储蓄、交易表格、Apple Pay 整理
  core/platforms/          各平台收据规则（DoorDash、Uber Eats、Uber）；共用流程在 core/receipt_pipeline.js
  ui/                      网页：index.html、style.html、app.js.html；i18n.js.html（语言切换）与 i18n-en.js.html（英文对照表）
apps/inbox/                记账-收件口：接收 Apple Pay 快捷指令（口令 + 限流）
tests/                     自动测试（node:test），Google 服务与 Gmail 用模拟对象
tools/preview.js           本地预览（npm run preview，使用假数据）
docs/                      部署指南、Apple Pay／快捷指令／Gmail 收据设置与手机验收清单
devpost/                   范围、产品需求、技术方案、开发清单、应用地图与进度记录
```

### 规划文档

部分规划文档提到 `.multiagent/`（AI 协作记录）或 `START_HERE.md` 中的文件，这些没有放进公开仓库。

| 文件 | 内容 |
| --- | --- |
| [`devpost/scope.md`](devpost/scope.md) | 第一版范围 |
| [`devpost/prd.md`](devpost/prd.md) | 产品行为与验收场景 |
| [`devpost/spec.md`](devpost/spec.md) | 技术方案、权限、费用与风险 |
| [`devpost/checklist.md`](devpost/checklist.md) | 开发切片、试用评审与修改记录 |
| [`devpost/app-map.html`](devpost/app-map.html) | 应用地图：各部分怎样连接、想改东西从哪里下手 |
| [`devpost/plan.md`](devpost/plan.md) | 推进计划与进度记录 |
| [`devpost/progress-summary.md`](devpost/progress-summary.md) | 当前进度与下一阶段交接 |

## 安全规则

- 仓库中不得出现：口令、网页应用或收件口网址、表格 ID、脚本 ID、真实邮件、真实账目。
- `.clasp.json`（含脚本 ID）与 `.clasprc.json`（clasp 登录凭据）已被 `.gitignore` 忽略；仓库中只有 `.clasp.json.example`。
- 提交前运行 `devpost/spec.md` 第 9.5 节的检查搜索，确认没有结果。
- 「账本」表格只看不改；「收件箱」表格不要手动排序或编辑。

## 关于这个项目

这是一个学习用 AI 协作做产品的项目：由一个 PM 角色整理需求、开发与评审角色分别实现和独立检查，每一步都先经作者审阅确认再执行。
