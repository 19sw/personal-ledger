---
doc: checklist
status: approved
language: zh-CN
---

<!-- 本文件于 2026-10-26 按 5-build 的格式补建。开发顺序早已按 spec.md 第 10 节和 plan.md 第 4a 节批准并执行，
     这里只如实记录已发生的事；没有证据的项目保持未勾选。 -->

# Build Checklist

Build mode: fast（实际以 PM 带领的多智能体流程进行：每个任务单经你批准 → Developer 实现 → Reviewer 独立评审；你在每次上线后用 iPhone 检查）

## Slices

- [x] **1. 能在手机上记一笔，并看到当月三张月报**
  Becomes usable: iPhone Safari 打开“只有我”可访问的网页，记一笔／编辑／删除／恢复，区分兼职收入来源，金额缺失的账目显示“待补全”并可补填，月报显示支出构成、收入构成和收支对比。
  Why now: 这是两个自动入口最终都要写进去的同一本账；先让账本和报表可用，后面每个切片都有落脚点。包含项目搭建（git、clasp、Google 表格、部署）。
  PRD ref: `prd.md > 2. 一笔交易包含什么`、`3. 账目页（首页）`、`4. 记一笔／编辑`、`5. 月报`
  Spec ref: `spec.md > 4. 数据模型`、`spec.md > 7. 月报计算规则`、`spec.md > 9.4 计划的文件结构`、`spec.md > 10 切片 1`
  Build: `apps/main` 的账本服务、费城时区归月、三张月报、四个页面；`setupLedger` 建表；部署为“只有我”的网页。
  Verify (mechanical): `node --test tests/` 51/51 通过（625b59f、bde4002）；用户本人推送、运行 setupLedger 并发布，iPhone 可打开（10-14）。
  Learner check: 用 iPhone 打开网页，记一笔支出和一笔兼职收入，打开月报看到它们分别出现在支出和收入构成里。
  Commit: `Repo foundation and slice 1: core ledger and monthly reports`

- [x] **2. 记账像现在用的 App 一样顺手**
  Becomes usable: 薄荷绿界面、月度汇总卡片、类别图标；两步记账（先选类别格子，再用自带数字键盘输入金额）；23 个默认类别。
  Why now: 你在 10-14 第一次手机试用后提出要“像现在用的 App 一样方便”，越早改，后面的页面越能沿用同一风格。
  PRD ref: `prd.md > 4. 记一笔／编辑`
  Spec ref: `spec.md > 8. 网页结构与状态提示（概要）`
  Build: 任务 03–04：界面样式、底部导航、记账动画、本地预览（`tools/preview.js`）、两步记账面板。
  Verify (mechanical): 自动测试通过，本地预览检查；独立评审通过（00798bb、1923fc7）。
  Learner check: 打开“记一笔”，先点一个类别，再用面板里的数字键盘输入金额并保存。
  Commit: `Soft mint UI: 4-item nav, month summary card, category icons, save animation, local preview`

- [x] **3. 预算、圆环报表、账单和小猫助手**
  Becomes usable: 月总预算与类别预算（接近／超出变色）、圆环报表、月／年账单、“我的”页打卡、左上角小猫助手（提醒、夸奖、5 个问题按钮、红点、“去处理”可逐月查看）。
  Why now: 按 plan.md 3a 的决定放在核心账本之后、Gmail 之前；它只依赖账本数据，不依赖还没验证的自动入口。
  PRD ref: `prd.md > 6A. 预算与小助手`
  Spec ref: `spec.md > 7A. 预算与小助手`、`spec.md > 10 切片 1B`
  Build: 任务 05–07：预算页、圆环报表、账单、打卡、小助手规则与对话窗口。
  Verify (mechanical): `node --test tests/` 159/159（10-15）；第 7A.6 节验收数字写成自动测试；独立评审通过（73196a6、3316a04、d860f97）。
  Learner check: 设一个总预算，记几笔支出，看小猫图标出现红点，点开看到预算提醒；点“本月到今天的收支”。
  Commit: `Budgets, donut reports and month/year bills; 5-item nav`

- [x] **4. 页面切换动画与音效**
  Becomes usable: 薄荷涟漪页面切换、导航滑动小圆块、切换和记账成功音效、金额飘字，“我的”里可关音效。
  Why now: 属于体验打磨，放在主要页面都已成形之后，避免反复返工。
  PRD ref: `prd.md > 1. 页面一览`
  Spec ref: `spec.md > 8. 网页结构与状态提示（概要）`
  Build: 任务 08–09；修复 iPhone 第一次点击不出声、来电打断后恢复。
  Verify (mechanical): `node --test tests/` 175/175；评审一次不通过后修复并通过（5059ea8、19bae74、8ff6b4c）。
  Learner check: 在 iPhone 上切换页面听到音效，记一笔看到金额飘字；在“我的”关掉音效后不再有声音。
  Commit: `Add page-switch (S2) and save-success (R3) sounds, floating amount text, sound toggle in 我的 (Task 09)`

- [x] **5. 实体店 Apple Pay 付款自动进账本**
  Becomes usable: iPhone 用 Apple Pay 付款后，快捷指令把交易送到“记账-收件口”，主程序每 5 分钟整理进账本；读不到金额时显示为待补全；跨入口疑似重复会提示。
  Why now: 核心特点的第一个自动入口；需要真实刷卡才能证明，风险高，所以单独成片并做强评审。
  PRD ref: `prd.md > 6. 自动记账行为`（6.1、6.2）、`prd.md > 7. 验收场景`（真实 Apple Pay）
  Spec ref: `spec.md > 5. Apple Pay 实体店路线`、`spec.md > 10 切片 3`
  Build: 任务 10：`apps/inbox` 收件口（口令、限流）、`processInbox`、跨渠道重复标记；操作指南 `docs/applepay-setup.md`、`docs/shortcut-setup.md`。
  Verify (mechanical): `node --test tests/` 237/237；强评审修 3 处后通过（8d76cdd、0e3e351、1a82f10）；手动运行端到端（A2 第 8A 步）通过；真实刷卡（A2 第 8B 步）用户确认成功。
  Learner check: 在实体店用 Apple Pay 付一笔，几分钟后在网页账目里看到这笔交易。
  Commit: `Apple Pay inbox: project I endpoint, inbox processing in M, cross-channel dups, rate-limit markers (Task 10)`

- [x] **6. Gmail 邮件账单自动进账本**
  Becomes usable: DoorDash 外卖、Uber Eats 外卖、Uber 打车的收据邮件到达后约 15 分钟内自动入账（打车记“交通”）；名单外像收据的邮件进入“待查看邮件”，可记一次、加入名单、静音或标记已查看。
  Why now: 核心特点的第二个自动入口；收据格式需要先用只读试运行（G1）摸清，所以放在 Apple Pay 之后，并分 G1 → G2 两阶段开启。
  PRD ref: `prd.md > 6. 自动记账行为`、`prd.md > 7. 验收场景`（真实外卖收据、重复收据）
  Spec ref: `spec.md > 6. Gmail 邮件账单路线`、`spec.md > 6.8 验证实验`、`spec.md > 10 切片 2`
  Build: 任务 11、任务 12，以及 10-25 的 Uber 中文收据和收据证据判定修正；第 9 版已于 10-26 部署（f7479ee）。
  Verify (mechanical): `node --test tests/` 379/379（10-26 本地重跑）；各轮独立评审 PASS；G1 只读试运行已做。G2 轮询已开启；最终试用中你确认自动入账正常（10-26）。
  Learner check: 点一单外卖或打一次 Uber，约 15 分钟后在网页账目里看到这笔交易，金额与收据一致。
  Commit: `Release v9: receipt fixes, ledger column repair, savings and spending habits`

- [x] **7. 按日期范围生成收支交易表格**
  Becomes usable: 在小猫助手里选开始和结束日期，生成一个独立的 Google 表格（可下载 Excel），按月分组、余额连续累计、附整月总预算对比；Apple Pay 显示 `Apple Pay`，Gmail 来源显示 `Online Order`。
  Why now: 10-22 你提出的新需求，只读账本，不影响自动入口，可以在等待 Gmail 修正期间独立完成。
  PRD ref: `prd.md > 6A.6 生成个人收支交易表格`
  Spec ref: `spec.md > 7A`（交易表格段落）、`spec.md > 9.4 计划的文件结构`（`core/transaction_table.js`）
  Build: `core/transaction_table.js` 与 `api_generateTransactionReport`；标签与预算导出修正。
  Verify (mechanical): 自动测试 335/335（10-22）；10-23 第 8 版线上生成 13 笔真实报表并逐行核对 XLSX，独立审查 PASS。
  Learner check: 在小猫助手选一段日期生成表格，打开 Google 表格核对余额与账本一致。
  Commit: `docs: design automatic transaction labels`

- [x] **8. 储蓄目标与消费习惯**
  Becomes usable: 储蓄目标、记录存入和预估；消费习惯报告页。
  Why now: 10-23 你提出的扩展需求，在账本和报表稳定后加入。
  PRD ref: 未写入 PRD（见 Revisions）
  Spec ref: 未写入 spec（见 Revisions）
  Build: `core/savings.js`、`core/savings_service.js`、对应网页接口与页面；第 9 版部署。
  Verify (mechanical): 储蓄与消费习惯测试纳入全量 379/379（8ba619d、c533d0d）；新公开接口已加入评审过的允许名单。
  Learner check: 在网页里建一个储蓄目标并记一笔存入，打开消费习惯页查看。
  Commit: `test: add spending habits page tests and fixed server clock`

- [x] **9. 状态展示与收尾**
  Becomes usable: 设置页能看到各自动入口的状态和错误；README 的部署步骤与实际一致；公开仓库通过安全检查。
  Why now: 放在最后，因为它描述的是已经完成的功能，并为 6-ship 的公开仓库做准备。
  PRD ref: `prd.md > 6.4 状态可见`
  Spec ref: `spec.md > 6.7 状态可见`、`spec.md > 9.5 公开仓库的安全规则`、`spec.md > 10 切片 4`
  Build: 核对状态展示；更新 README（目前仍把 Apple Pay、Gmail 写成“计划中”，并列着已去掉的熊猫外卖）；按 9.5 节检查仓库。
  Verify (mechanical): `node --test tests/` 380/380（含 `tests/secrets.test.js`）；README 与实际功能逐项对照，去掉“计划中”和熊猫外卖；“我的”页的 Apple Pay 与 Gmail 状态在试用中确认可见。
  Learner check: 打开 README，确认一个没见过这个项目的人能看懂它是什么、怎么部署。
  Commit: `Refresh README and status display for submission`

- [x] **10. 界面可以切换中文或英文**
  Becomes usable: 在“我的”页选择“中文 / English”，所有页面、提示、默认类别和小猫助手立刻换成英文；自建内容保持原样；交易表格按当时的语言生成；再切回中文完全恢复。
  Why now: 提交前加入（你在 6-ship 时提出）：Devpost 评审需要看懂演示视频和仓库，以后自己或他人也能用英文界面。放在公开仓库和录视频之前，因为两者都要用到英文界面。
  PRD ref: `prd.md > 6B. 界面语言`、`prd.md > 7. 验收场景`（界面语言）
  Spec ref: `spec.md > 8A. 界面语言切换`
  Build: 新增 `apps/main/ui/i18n.js.html`（对照表与页面翻译器）；“我的”页语言开关；`api_bootstrap` 附带默认类别英文名；交易表格导出支持 `lang`；README 改为英文为主并新增 `README.zh-CN.md`。
  Verify (mechanical): `node --test tests/` 全部通过；新测试在英文模式下逐页检查没有漏翻的中文（用户输入内容除外）、切回中文后恢复、导出表头为英文；本地预览逐页查看英文界面。
  Learner check: 在 iPhone 上到“我的”切换到 English，逐页看一遍、问小猫助手一个问题、生成一份交易表格；再切回中文。
  Commit: `Add Chinese/English interface switch`
  Status: 已实现并在本地提交（21128df 及评审修复）；`node --test tests/` 386/386、`npm run check:i18n` 通过；本地预览逐页看过英文界面；独立评审 PASS（修了英文序数词和一处去空白的写法）。已推送并原地更新为第 11 版（网址不变，无需 setupLedger）；你已在 iPhone 上确认英文各页面正常、切回中文正常。

## Hands-on Checkpoints

- [x] Early usable behavior explored — 第 2 版上线后（切片 1–3），你在 iPhone 上检查通过（10-15）；你的反馈带来了两步记账、预算、小猫助手和动画音效等后续任务。
- [x] Final kick-the-tires exploration and feedback completed — 10-26 你在 iPhone 上完整试用；反馈 1 条（消费习惯中的 Apple Pay），已修复并复查

## Final Review

已做的机械检查（2026-10-26）：`node --test tests/` 379/379 通过。下面是目前已知、需要在最终试用中处理或确认的项目：

- [x] Gmail G2：确认轮询已开启，并用一笔真实外卖或打车收据验证入账（切片 6）
- [x] 第 4 版 iPhone 检查：页面切换、音效、静音开关、第一次记账有声音
- [x] “去处理”按钮：有待处理的自动记账账目时确认能跳到对应月份
- [x] 储蓄目标与消费习惯：在 iPhone 上实际用一次
- [x] 交易表格：在普通浏览器里点应用内的 Excel 下载按钮能正常下载
- [x] README 更新（切片 9）
- [x] 消费习惯：仍是“未分类”的 Apple Pay 账目单独显示为“Apple Pay”，手动改过类别的按手动类别算（你的试用反馈）— 已实现，两张表都改为逐笔分组；`node --test tests/` 380/380；已推送并原地更新为第 10 版（网址不变，无需 setupLedger）；你已在 iPhone 上确认显示正确
- [x] 月报支出构成：仍是“未分类”的 Apple Pay 显示为“Apple Pay”（你在英文界面试用时提出）；英文月报“本月预算小结”各种组合都能翻译 — 已实现，`node --test tests/` 388/388；已推送并原地更新为第 12 版（网址不变，无需 setupLedger）；你已在 iPhone 上确认显示正确
- [x] Final review complete — feedback resolved and learner confirms ready to ship（10-26 你确认可以提交）

## Code Tour and App Map

- [x] Learning activity complete — guided route, focused alternative, prior practice connected, or brief recap
- [x] Optional edit and transfer reflection addressed — offered/declined/already covered/not applicable as appropriate
- [x] `devpost/app-map.html` generated from finished code, checked, and shown, including a project-grounded practice to reuse

Activity and evidence: 10-26 引导路线：你在本地预览里记了一笔，再在编辑器里沿着这笔账走完三站。连接到你的学习目标：知道功能在代码哪里，才能给 AI 更准确的指令并检查它的修改。
Route and stops: 三站均已完成：`apps/main/ui/app.js.html` 的 `saveForm` → `apps/main/web.js` 的 `api_saveEntry` → `apps/main/core/service.js` 的 `svcSaveEntry`。
Edit outcome: 已提供（改“先填金额”提示），未进行；代码无改动。
Reflection: 已提问并回答（内容只记在不公开的学习者档案中）。
Activity mode: 本地预览（假数据）+ 编辑器。

## Revisions

- 补建本清单 — 开发期间进度记在 `plan.md` 第 4a 节和 `.multiagent/runs/` 中，没有按 5-build 的格式建 `checklist.md`；本清单按实际提交、测试和上线记录补写，原来的开发顺序不变。
- 切片 2 和 3 的顺序对调（先 Apple Pay，后 Gmail）— spec 第 10 节原定先做 Gmail；实际先完成了 Apple Pay，Gmail 规则在 G1 试运行后需要修正。
- 去掉熊猫外卖，加入 Uber 打车（记“交通”）和“名单商家＋待查看邮件”— G1 发现熊猫外卖没有邮件、Uber 邮件都是打车、DoorDash 收据没有订单号；你在 10-22 决定（消息 181–185），scope／PRD／spec 已同步。
- DoorDash 疑似重复改为“同一家餐厅＋6 小时内”— 收据里读不到订单号（D7 修改）。
- 加入界面美化、动画音效（切片 2、4）— 你在手机试用后提出，属于体验改进，不改变核心特点。
- 加入交易表格（切片 7）— 10-22 你提出的新需求，已写入 `prd.md > 6A.6`。
- 加入储蓄目标与消费习惯（切片 8）— 10-23 你提出的新需求；PRD 和 spec 尚未补写这部分。
- 公开仓库的安全检查（spec 9.5）从切片 9 移到 6-ship — 官方流程把发布前的历史与隐私检查放在 6-ship 统一进行。
- 新增切片 10（界面中英文切换）— 你在 6-ship 开始时提出，为了让 Devpost 评审看懂演示与仓库，以后也能切换语言；scope／PRD（6B）／spec（8A）已同步更新。
