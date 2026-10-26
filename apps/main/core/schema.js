/**
 * 「账本」表格里各工作表的列定义（spec 4.1–4.3）。
 * 列的类型：
 *   str  文本（空格子读出来是 null）
 *   int  整数（金额用整数美分；空格子读出来是 null）
 *   bool 是/否
 * 后续切片（预算、小助手、Gmail、Apple Pay）会在这里追加自己的工作表。
 */
var LEDGER_SCHEMA = {
  entries: {
    key: 'id',
    columns: [
      ['id', 'str'], ['type', 'str'], ['amount_cents', 'int'], ['occurred_at', 'str'],
      ['month_ny', 'str'], ['date_ny', 'str'], ['category_id', 'str'], ['income_source_id', 'str'],
      ['merchant', 'str'], ['note', 'str'], ['channel', 'str'], ['platform', 'str'],
      ['is_refund', 'bool'], ['refund_of', 'str'], ['flag_dup', 'bool'], ['dup_group', 'str'],
      ['flag_amount_review', 'bool'], ['source_key', 'str'], ['order_ref', 'str'],
      ['created_at', 'str'], ['updated_at', 'str'], ['deleted_at', 'str'],
      // 后来新增的列只能加在最后：表格按列的位置读写，线上账本靠 setupLedger 在末尾补列（见 tests/store.test.js）
      ['restaurant_key', 'str']
    ]
  },
  categories: {
    key: 'id',
    columns: [['id', 'str'], ['type', 'str'], ['name', 'str'], ['sort', 'int'], ['archived', 'bool'], ['system_key', 'str']]
  },
  income_sources: {
    key: 'id',
    columns: [['id', 'str'], ['name', 'str'], ['archived', 'bool']]
  },
  month_meta: {
    key: 'month',
    columns: [['month', 'str'], ['last_changed_at', 'str']]
  },
  // 去重凭据：永不清理（spec 4.2）。切片 1 只建表，切片 2/3 开始写入。
  processed_sources: {
    key: 'source_key',
    columns: [['source_key', 'str'], ['entry_id', 'str'], ['outcome', 'str'], ['processed_at', 'str']]
  },
  // “两笔都保留”的记录：pair_key = 两个账目 id 排序后用 | 连接，保证每一对只有一行
  dup_dismissed: {
    key: 'pair_key',
    columns: [['pair_key', 'str'], ['entry_a', 'str'], ['entry_b', 'str']]
  },
  // 预算历史（spec 7A.1）：只追加或更新“当月”那一行，从不改动过去月份；amount_cents 为空 = 从该月起取消
  budgets: {
    key: 'id',
    columns: [['id', 'str'], ['scope', 'str'], ['amount_cents', 'int'], ['effective_from', 'str'], ['updated_at', 'str']]
  },
  // 设置（键值对）：budget_near_pct = 接近预算的提醒比例（默认 80）
  settings: {
    key: 'key',
    columns: [['key', 'str'], ['value', 'str']]
  },
  // 储蓄独立于日常账目：初始余额 + 存入记录 = 当前进度，不计入支出或收入。
  savings_goals: {
    key: 'id',
    columns: [['id', 'str'], ['name', 'str'], ['target_cents', 'int'], ['starting_saved_cents', 'int'],
      ['monthly_cents', 'int'], ['target_date', 'str'], ['created_at', 'str'], ['updated_at', 'str']]
  },
  savings_contributions: {
    key: 'id',
    columns: [['id', 'str'], ['goal_id', 'str'], ['amount_cents', 'int'], ['date_ny', 'str'], ['created_at', 'str']]
  },
  // 手动估算只对所填月份生效。空值表示使用历史数据；0 是有效的手动金额。
  savings_estimates: {
    key: 'month',
    columns: [['month', 'str'], ['income_cents', 'int'], ['expense_cents', 'int'], ['updated_at', 'str']]
  },
  // 打卡（Task 06）：每个费城日期一行 = 这一天新建过账目（按创建时间，不按交易日期）。删除或清理账目都不会删掉打卡
  checkins: {
    key: 'date_ny',
    columns: [['date_ny', 'str'], ['first_entry_at', 'str']]
  },
  // 小助手发出的提醒和夸奖（spec 7A.1）；items_json = 结构化的小行 [{label, amount_cents}]（JSON 文字，可为空）
  assistant_messages: {
    key: 'id',
    columns: [['id', 'str'], ['created_at', 'str'], ['skill_id', 'str'], ['dedup_key', 'str'], ['month', 'str'],
      ['text', 'str'], ['action', 'str'], ['read_at', 'str'], ['items_json', 'str']]
  },
  // 每条规则上一次的状态，以及“只发一次”的去重键（spec 7A.1 / 7A.3）。不清理
  assistant_state: {
    key: 'state_key',
    columns: [['state_key', 'str'], ['value', 'str'], ['updated_at', 'str']]
  },
  // 各自动渠道的运行状态（spec 4.3 / PRD 6.4，切片 3 起）。last_error_text 只写错误类型的说明，不写任何收据或请求内容；
  // stale_count = 收件箱中超过 7 天仍未整理的交易行数
  channel_status: {
    key: 'channel',
    columns: [['channel', 'str'], ['last_run_at', 'str'], ['last_success_at', 'str'], ['last_entry_at', 'str'],
      ['last_error_at', 'str'], ['last_error_code', 'str'], ['last_error_text', 'str'], ['stale_count', 'int'],
      ['last_latency_sec', 'int']]
  },
  // Apple Pay 收件口的限流标记（从「收件箱」的标记行同步过来，spec 5.3）：首页警告和小助手消息都看这里，
  // 这样不读收件箱也能提醒；收件箱的原始标记行 30 天后被清理，这里不清理
  apple_pay_markers: {
    key: 'marker_at',
    columns: [['marker_at', 'str'], ['rejected_count', 'int'], ['updated_at', 'str']]
  },
  // D16“待查看邮件”（Task 11）：看不出是不是外卖消费、或同时像多个平台的邮件，不入账，列在这里等你查看。
  // 只保存邮件编号、平台 id（多个用逗号隔开）、到达时间和原因代码，不保存主题、正文、地址或任何片段（spec 6.3）。
  // reviewed_at = 你点“已查看”的时间（之后不再列出）。不清理：同一封邮件不会被重复列出
  gmail_pending: {
    key: 'message_id',
    columns: [['message_id', 'str'], ['platforms', 'str'], ['received_at', 'str'], ['reason', 'str'], ['reviewed_at', 'str'],
      ['created_at', 'str'], ['sender_domain', 'str'], ['amount_cents', 'int']]
  },
  mail_senders: {
    key: 'domain',
    columns: [['domain', 'str'], ['display_name', 'str'], ['category_id', 'str'], ['mode', 'str'], ['created_at', 'str']]
  }
};

/**
 * 后来新增的工作表。线上账本在你重新运行一次 setupLedger 之前没有这些表：
 * - budgets / settings：读取时当作“没有预算、使用默认设置”，写入时提示先运行 setupLedger（见 service.js 的 listOptional_）；
 * - checkins / assistant_messages / assistant_state（Task 06）：读取时当作空表，写入时直接跳过（不报错、不建表）。
 * - channel_status / apple_pay_markers（Task 10）：同上；Apple Pay 账目照常整理，只是状态和限流提醒要等表建好后才有。
 * - gmail_pending（Task 11）：读取时当作空表；外卖收据轮询在这张表建好之前不会运行（SETUP_REQUIRED）。
 * - savings_goals / savings_contributions / savings_estimates：读取当作空表并返回 ready=false；写入提示先运行 setupLedger。
 */
var OPTIONAL_TABLES = { budgets: true, settings: true, checkins: true, assistant_messages: true, assistant_state: true,
  channel_status: true, apple_pay_markers: true, gmail_pending: true, mail_senders: true,
  savings_goals: true, savings_contributions: true, savings_estimates: true };

function schemaColumnNames(table) {
  return LEDGER_SCHEMA[table].columns.map(function (c) { return c[0]; });
}
