/**
 * 账本规则（纯函数，不读写表格）：默认类别、输入校验、新建/修改/删除/恢复/清理、收入来源去重。
 * 读写表格的部分在 service.js（通过 repo 接口）和 store.js（真正的 Google 表格）。
 */

var PURGE_AFTER_DAYS = 30;
var DAY_MS = 86400000;
var UNCATEGORIZED_KEY = 'uncategorized';

/**
 * 默认类别。顺序 = 网格里的显示顺序（sort 按数组位置生成）：每种类型先是原有的类别，
 * 再是 2026-10-14 客户确认新增的类别，“其他”“未分类”永远排在最后。
 * “未分类”是系统类别，不可删除、不可改名（D9）。id 一旦发布就不要改（svcEnsureDefaults 靠 id 判断是否已存在）。
 */
var DEFAULT_CATEGORIES = [
  { id: 'exp_dining', type: 'expense', name: '餐饮', name_en: 'Dining' },
  { id: 'exp_shopping', type: 'expense', name: '购物', name_en: 'Shopping' },
  { id: 'exp_transport', type: 'expense', name: '交通', name_en: 'Transport' },
  { id: 'exp_housing', type: 'expense', name: '住房', name_en: 'Housing' },
  { id: 'exp_daily', type: 'expense', name: '日用', name_en: 'Daily Needs' },
  { id: 'exp_entertainment', type: 'expense', name: '娱乐', name_en: 'Leisure' },
  { id: 'exp_vegetables', type: 'expense', name: '蔬菜', name_en: 'Vegetables' },
  { id: 'exp_fruit', type: 'expense', name: '水果', name_en: 'Fruit' },
  { id: 'exp_snacks', type: 'expense', name: '零食', name_en: 'Snacks' },
  { id: 'exp_coffee_tea', type: 'expense', name: '咖啡奶茶', name_en: 'Coffee & Tea' },
  { id: 'exp_groceries', type: 'expense', name: '买菜', name_en: 'Groceries' },
  { id: 'exp_clothing', type: 'expense', name: '服饰', name_en: 'Clothing' },
  { id: 'exp_beauty', type: 'expense', name: '美容', name_en: 'Beauty' },
  { id: 'exp_medical', type: 'expense', name: '医疗', name_en: 'Medical' },
  { id: 'exp_sports', type: 'expense', name: '运动', name_en: 'Sports' },
  { id: 'exp_travel', type: 'expense', name: '旅行', name_en: 'Travel' },
  { id: 'exp_telecom', type: 'expense', name: '通讯', name_en: 'Phone' },
  { id: 'exp_subscription', type: 'expense', name: '订阅会员', name_en: 'Subscriptions' },
  { id: 'exp_study', type: 'expense', name: '学习', name_en: 'Study' },
  { id: 'exp_books', type: 'expense', name: '书籍', name_en: 'Books' },
  { id: 'exp_digital', type: 'expense', name: '数码', name_en: 'Electronics' },
  { id: 'exp_pets', type: 'expense', name: '宠物', name_en: 'Pets' },
  { id: 'exp_gifts', type: 'expense', name: '礼物', name_en: 'Gifts' },
  { id: 'exp_social', type: 'expense', name: '社交', name_en: 'Social' },
  { id: 'exp_other', type: 'expense', name: '其他', name_en: 'Other' },
  { id: 'exp_uncategorized', type: 'expense', name: '未分类', name_en: 'Uncategorized', system_key: UNCATEGORIZED_KEY },
  { id: 'inc_salary', type: 'income', name: '工资', name_en: 'Salary' },
  { id: 'inc_parttime', type: 'income', name: '兼职', name_en: 'Part-time' },
  { id: 'inc_bonus', type: 'income', name: '奖金', name_en: 'Bonus' },
  { id: 'inc_redpacket', type: 'income', name: '红包礼金', name_en: 'Cash Gifts' },
  { id: 'inc_reimbursement', type: 'income', name: '报销', name_en: 'Reimbursement' },
  { id: 'inc_tax_refund', type: 'income', name: '退税', name_en: 'Tax Refund' },
  { id: 'inc_interest', type: 'income', name: '利息', name_en: 'Interest' },
  { id: 'inc_other', type: 'income', name: '其他', name_en: 'Other' }
];

/** 内置类别的英文名（界面切到 English 时显示，spec 8A）；自建类别没有英文名，返回 null。表格里不保存英文名。 */
function defaultCategoryNameEn(id) {
  for (var i = 0; i < DEFAULT_CATEGORIES.length; i++) if (DEFAULT_CATEGORIES[i].id === id) return DEFAULT_CATEGORIES[i].name_en;
  return null;
}

/** 必须排在最后的类别：两个“其他”和系统类别“未分类”。 */
function isTailCategory_(c) {
  return c.id === 'exp_other' || c.id === 'inc_other' || c.system_key === UNCATEGORIZED_KEY;
}

var CHANNEL_LABEL = { manual: '手动', apple_pay: 'Apple Pay', gmail_receipt: 'Gmail' };
var PLATFORM_LABEL = { doordash: 'DoorDash', uber: 'Uber', ubereats: 'Uber Eats' };

function channelLabel(e) {
  if (e.channel === 'gmail_receipt') {
    return 'Gmail（' + (PLATFORM_LABEL[e.platform] || e.platform || '外卖') + '）';
  }
  return CHANNEL_LABEL[e.channel] || e.channel;
}

/** 用户可见的错误（界面直接显示 message）。 */
function UserError(message) {
  var err = new Error(message);
  err.userError = true;
  return err;
}

/** 名称比较用：去掉首尾空格、合并中间空白、不区分大小写（spec 4.3）。 */
function nameKey(name) {
  return String(name || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function cleanText_(value, maxLen) {
  var s = String(value === null || value === undefined ? '' : value).trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

/**
 * 在已有来源中按名称查找（不区分大小写）；找不到就返回需要新建的来源。
 * 返回 {source, created, reactivated}。已归档的同名来源会被重新启用，而不是再建一个。
 */
function findOrCreateSource(sources, name, newId) {
  var display = cleanText_(name, 60).replace(/\s+/g, ' ');
  if (!display) throw UserError('来源名称不能为空');
  var key = nameKey(display);
  for (var i = 0; i < sources.length; i++) {
    if (nameKey(sources[i].name) === key) {
      return { source: sources[i], created: false, reactivated: !!sources[i].archived };
    }
  }
  return { source: { id: newId(), name: display, archived: false }, created: true, reactivated: false };
}

/**
 * 校验“记一笔/编辑”提交的内容，返回要写入的字段。
 * input: {type, amount, local_datetime, category_id, income_source_id, new_source_name,
 *         merchant, note, is_refund, refund_of}
 * existing: 编辑时的原账目；新建时为 null。
 * ctx: {categories, sources, entries, newId}
 * 返回 {fields, newSource}（newSource 非空表示需要新建或重新启用的来源）。
 */
function validateEntryInput(input, existing, ctx) {
  input = input || {};
  var isManual = !existing || existing.channel === 'manual';

  // 类型：自动记录的类型不可改
  var type = isManual ? input.type : existing.type;
  if (type !== 'expense' && type !== 'income') throw UserError('请选择支出或收入');

  // 退款：只有支出可以是退款；自动记录的退款标记保持不变
  var isRefund = isManual ? (type === 'expense' && !!input.is_refund) : !!existing.is_refund;

  // 金额
  var amountText = input.amount === null || input.amount === undefined ? '' : String(input.amount).trim();
  var amount;
  if (amountText === '') {
    if (!existing) throw UserError('手动记录时金额必填');
    if (existing.amount_cents !== null && existing.amount_cents !== undefined) throw UserError('金额不能清空');
    amount = null; // 自动记录仍未补全
  } else {
    if (/^[-−]/.test(amountText)) throw UserError('金额必须大于 0；退款请勾选“这是退款”');
    var cents = parseUsdToCents(amountText);
    if (cents === null) throw UserError('金额格式不正确，例如 12.34');
    if (!(cents > 0)) throw UserError('金额必须大于 0');
    amount = isRefund ? -cents : cents;
  }

  // 时间（按费城时间理解）
  var occurred = parseLocalNY(input.local_datetime);

  // 退款关联的原交易（可选）
  var refundOf = null;
  var original = null;
  if (isRefund && input.refund_of && existing && existing.refund_of === input.refund_of) {
    // 关联未改变：原交易即使已删除或已被清除也保留关联，退款仍是独立账目（spec 4.5、6.6）
    refundOf = existing.refund_of;
    original = findById_(ctx.entries, refundOf);
  } else if (isRefund && input.refund_of) {
    // 新建或修改了关联：要求原交易存在且未删除
    original = findById_(ctx.entries, input.refund_of);
    if (!original || original.deleted_at) throw UserError('找不到要关联的原交易');
    if (original.type !== 'expense' || original.is_refund) throw UserError('只能关联一笔普通支出');
    if (existing && original.id === existing.id) throw UserError('不能关联自己');
    refundOf = original.id;
  }

  // 类别：退款未选类别时默认与原交易相同（PRD 第 4 节）
  var categoryId = input.category_id || (original ? original.category_id : '');
  var cat = findById_(ctx.categories, categoryId);
  if (!cat) throw UserError('请选择类别');
  if (cat.type !== type) throw UserError('类别与支出/收入类型不一致');
  if (cat.archived && !(existing && existing.category_id === cat.id)) throw UserError('这个类别已删除，请选择其他类别');

  // 收入来源（仅收入）
  var sourceId = null;
  var newSource = null;
  if (type === 'income') {
    if (input.new_source_name && String(input.new_source_name).trim()) {
      var found = findOrCreateSource(ctx.sources, input.new_source_name, ctx.newId);
      sourceId = found.source.id;
      if (found.created || found.reactivated) newSource = found;
    } else if (input.income_source_id) {
      var src = findById_(ctx.sources, input.income_source_id);
      if (!src) throw UserError('找不到这个来源');
      if (src.archived && !(existing && existing.income_source_id === src.id)) throw UserError('这个来源已停用');
      sourceId = src.id;
    }
  }

  return {
    fields: {
      type: type,
      amount_cents: amount,
      occurred_at: occurred.toISOString(),
      month_ny: monthNY(occurred),
      date_ny: dateNY(occurred),
      category_id: cat.id,
      income_source_id: sourceId,
      merchant: cleanText_(input.merchant, 200),
      note: cleanText_(input.note, 1000),
      is_refund: isRefund,
      refund_of: refundOf
    },
    newSource: newSource
  };
}

function findById_(list, id) {
  if (!id) return null;
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** 新建一笔手动账目。记录渠道固定为 manual。 */
function buildManualEntry(fields, id, now) {
  var ts = now.toISOString();
  var e = {
    id: id, channel: 'manual', platform: null, flag_dup: false, dup_group: null,
    flag_amount_review: false, source_key: null, order_ref: null,
    created_at: ts, updated_at: ts, deleted_at: null
  };
  Object.keys(fields).forEach(function (k) { e[k] = fields[k]; });
  return e;
}

/** 修改：只覆盖校验过的字段；记录渠道、来源凭据等保持不变（PRD 第 4 节）。返回新对象。 */
function applyEntryEdit(existing, fields, now) {
  var e = {};
  Object.keys(existing).forEach(function (k) { e[k] = existing[k]; });
  Object.keys(fields).forEach(function (k) { e[k] = fields[k]; });
  e.updated_at = now.toISOString();
  return e;
}

/** 软删除：只写入删除时间，不删除行（spec 4.5）。 */
function softDeleteEntry(existing, now) {
  if (existing.deleted_at) throw UserError('这笔账目已经删除');
  return { deleted_at: now.toISOString(), updated_at: now.toISOString() };
}

function restoreEntryPatch(existing, now) {
  if (!existing.deleted_at) throw UserError('这笔账目没有被删除');
  return { deleted_at: null, updated_at: now.toISOString() };
}

/** 彻底清除的日期（删除时间 + 30 天）。 */
function purgeDueAt(entry) {
  return new Date(new Date(entry.deleted_at).getTime() + PURGE_AFTER_DAYS * DAY_MS);
}

/**
 * 需要彻底清除的账目：只选“已删除且删除时间超过 30 天”的行。
 * 未删除的账目、删除时间无法识别的账目一律不选（宁可多留，不误删）。
 */
function selectPurgeIds(entries, now) {
  return entries.filter(function (e) {
    if (!e.deleted_at) return false;
    var t = new Date(e.deleted_at).getTime();
    if (isNaN(t)) return false;
    return now.getTime() - t > PURGE_AFTER_DAYS * DAY_MS;
  }).map(function (e) { return e.id; });
}

/** 新增类别：同类型下同名（不区分大小写）的类别已存在时，重新启用而不是重复创建。 */
function planAddCategory(categories, type, name, newId) {
  if (type !== 'expense' && type !== 'income') throw UserError('类别类型不正确');
  var display = cleanText_(name, 30).replace(/\s+/g, ' ');
  if (!display) throw UserError('类别名称不能为空');
  var key = nameKey(display);
  var maxSort = 0;
  for (var i = 0; i < categories.length; i++) {
    var c = categories[i];
    if (c.sort > maxSort) maxSort = c.sort;
    if (c.type === type && nameKey(c.name) === key) {
      if (!c.archived) throw UserError('已有同名类别');
      return { reactivate: c };
    }
  }
  return { create: { id: newId(), type: type, name: display, sort: maxSort + 1, archived: false, system_key: null } };
}

/** 删除类别 = 归档（历史账目和月报不变）；“未分类”不可删除（D9）。 */
function checkArchiveCategory(cat) {
  if (!cat) throw UserError('找不到这个类别');
  if (cat.system_key === UNCATEGORIZED_KEY) throw UserError('“未分类”是系统类别，不能删除');
  if (cat.archived) throw UserError('这个类别已删除');
}
