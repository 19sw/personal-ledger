/**
 * 账本操作（给网页调用的业务逻辑）。通过 repo 接口读写数据：
 *   repo.list(table)             -> 对象数组（副本）
 *   repo.insert(table, obj)
 *   repo.update(table, key, patch)  按该表的主键（schema.js 中的 key）更新
 *   repo.removeByKeys(table, keys)  只用于 30 天清理
 * 正式运行时 repo 是 store.js 里的 Google 表格实现；测试时是内存实现，两者遵守同一接口。
 * 写操作由 web.js 在脚本锁里调用，这里不再加锁。
 */

/**
 * 初始化 / 升级默认类别（setupLedger 调用，可重复运行，结果不变）：
 *  - 只补“还没有的”默认类别：id 不存在，并且同类型下没有同名类别（不区分大小写，已归档的也算）。
 *  - 绝不重新启用、改名、复制已有类别；用户自己建的类别和所有账目都不动。
 *  - “其他”“未分类”要排在最后：只有这几行的 sort 会被改成更大的数，其他行的 sort 保持原样。
 */
function svcEnsureDefaults(repo) {
  var cats = repo.list('categories');
  var maxSort = 0;
  cats.forEach(function (c) { if (Number(c.sort) > maxSort) maxSort = Number(c.sort); });
  function row(d) {
    maxSort += 1;
    return { id: d.id, type: d.type, name: d.name, sort: maxSort, archived: false, system_key: d.system_key || null };
  }
  ['expense', 'income'].forEach(function (type) {
    var ofType = cats.filter(function (c) { return c.type === type; });
    var ids = {}, names = {};
    ofType.forEach(function (c) { ids[c.id] = true; names[nameKey(c.name)] = true; });
    function missing(d) { return d.type === type && !ids[d.id] && !names[nameKey(d.name)]; }

    // 1. 补齐普通类别（放在现有类别后面、“其他/未分类”前面）
    var normalMax = 0;
    ofType.forEach(function (c) { if (!isTailCategory_(c) && Number(c.sort) > normalMax) normalMax = Number(c.sort); });
    DEFAULT_CATEGORIES.forEach(function (d) {
      if (isTailCategory_(d) || !missing(d)) return;
      var r = row(d);
      repo.insert('categories', r);
      normalMax = r.sort;
    });

    // 2. “其他/未分类”如果不在最后，就把它们的 sort 改到最后（保持彼此的先后顺序）
    var tail = ofType.filter(isTailCategory_).sort(function (a, b) { return Number(a.sort) - Number(b.sort); });
    var tailBehind = tail.some(function (c) { return Number(c.sort) < normalMax; });
    if (tailBehind) {
      tail.forEach(function (c) { maxSort += 1; repo.update('categories', c.id, { sort: maxSort }); });
    }

    // 3. 缺少的“其他/未分类”（正常情况下不会发生）补在最后
    DEFAULT_CATEGORIES.forEach(function (d) {
      if (isTailCategory_(d) && missing(d)) repo.insert('categories', row(d));
    });
  });
}

/** 打开网页时调用：只有类别表完全是空的才写入整套默认类别；平时不写任何数据。 */
function svcSeedDefaultsIfEmpty_(repo) {
  if (repo.list('categories').length === 0) svcEnsureDefaults(repo);
}

/**
 * setupLedger 调用：settings 表里没有“接近预算比例”时写入默认 80；已有的值（包括你改过的）一律不动。
 */
function svcEnsureSettings(repo) {
  var has = repo.list('settings').some(function (r) { return r.key === BUDGET_NEAR_PCT_KEY; });
  if (!has) repo.insert('settings', { key: BUDGET_NEAR_PCT_KEY, value: String(BUDGET_NEAR_PCT_DEFAULT) });
}

/**
 * 读切片 1B 新增的工作表（budgets / settings）：线上账本重新运行 setupLedger 之前这些表还不存在，
 * 此时当作空表（没有预算、默认设置），打开网页不会因此出错，也不会自动建表。
 */
function listOptional_(repo, table) {
  if (OPTIONAL_TABLES[table] && repo.has && !repo.has(table)) return [];
  return repo.list(table);
}

/** 写入 budgets / settings 之前检查：表不存在时给出中文提示，请你先运行一次 setupLedger（不从网页自动建表）。 */
function requireTable_(repo, table) {
  if (repo.has && !repo.has(table)) {
    throw UserError('预算功能还没有启用：请先在脚本编辑器里重新运行一次 setupLedger（只需一次），再回来设置');
  }
}

function budgetReady_(repo) {
  return !repo.has || (repo.has('budgets') && repo.has('settings'));
}

/**
 * applePayConfigured：是否设置了「收件箱」（脚本属性 INBOX_SPREADSHEET_ID，由 web.js 判断）；没设置时 Apple Pay 显示为“未开启”。
 * gmailEnabledAt：外卖收据自动记账的开启时间（脚本属性，未开启为 null）。打开网页时不读 Gmail，只读账本里的状态。
 */
function svcBootstrap(repo, now, applePayConfigured, gmailEnabledAt) {
  var current = monthNY(now);
  return {
    budget_near_pct: readNearPct(listOptional_(repo, 'settings')),
    budget_ready: budgetReady_(repo),
    savings_ready: savingsReady_(repo),
    now_local: localNY(now),
    today_ny: dateNY(now),
    current_month: current,
    report_default_month: defaultReportMonth(now),
    categories: repo.list('categories').sort(function (a, b) { return a.sort - b.sort; }).map(function (c) {
      return Object.assign({}, c, { name_en: defaultCategoryNameEn(c.id) });
    }),
    sources: repo.list('income_sources').sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }),
    banner: bannerCounts(repo.list('entries'), current),
    checkin: svcCheckinView_(repo, now),
    assistant: { ready: assistantReady_(repo), unread_count: assistantUnreadCount_(repo, now) },
    apple_pay: svcApplePayStatus(repo, now, !!applePayConfigured),
    gmail: svcGmailStatusSafe_(repo, now, gmailEnabledAt || null)
  };
}

/** 外卖收据状态出任何错都不能让网页打不开：退回到“只显示开没开”的最简状态。 */
function svcGmailStatusSafe_(repo, now, enabledAt) {
  try {
    return svcGmailStatus(repo, now, enabledAt);
  } catch (e) {
    console.error('外卖收据状态读取失败：' + (e && e.name ? e.name : 'Error'));
    return { enabled: !!enabledAt, ready: false, last_run_local: null, last_success_local: null, stale: false, error: null,
      platforms: [], pending: [], pending_count: 0, warnings: [], unavailable: true };
  }
}

/** 给界面显示用的账目（附带类别名、来源名、状态等）。 */
function entryView_(e, lookups) {
  var cat = lookups.cats[e.category_id];
  var src = e.income_source_id ? lookups.srcs[e.income_source_id] : null;
  var status = entryStatus(e);
  var view = {
    id: e.id,
    type: e.type,
    amount_cents: e.amount_cents,
    local_datetime: localNY(e.occurred_at),
    date_ny: e.date_ny,
    month_ny: e.month_ny,
    category_id: e.category_id,
    category_name: cat ? cat.name : '未知类别',
    display_category_name: e.channel === 'apple_pay' ? 'Apple Pay'
      : (e.channel === 'gmail_receipt' ? 'Online Order' : (cat ? cat.name : '未知类别')),
    income_source_id: e.income_source_id,
    source_name: e.type === 'income' ? (src ? src.name : UNSPECIFIED_SOURCE_NAME) : null,
    merchant: e.merchant || '',
    note: e.note || '',
    channel: e.channel,
    channel_label: channelLabel(e),
    is_refund: !!e.is_refund,
    refund_of: e.refund_of,
    refund_of_label: null,
    status: status,
    status_label: STATUS_LABEL[status],
    deleted_at: e.deleted_at
  };
  if (e.refund_of) {
    var orig = lookups.entries[e.refund_of];
    view.refund_of_label = orig
      ? (orig.date_ny + ' ' + (orig.merchant || (lookups.cats[orig.category_id] || {}).name || '') + ' ' + formatCents(orig.amount_cents)) + (orig.deleted_at ? '（原交易已删除）' : '')
      : '原交易已清除';
  }
  if (e.deleted_at) view.purge_on = dateNY(purgeDueAt(e));
  return view;
}

function lookups_(repo, entries) {
  var byId = {};
  entries.forEach(function (e) { byId[e.id] = e; });
  return { cats: indexById_(repo.list('categories')), srcs: indexById_(repo.list('income_sources')), entries: byId };
}

/**
 * 账目页：某个月的账目，按日期倒序分组，每天显示当日支出小计（已知金额之和，退款为负）。
 * filter = 'attention' 时只显示待补全和待核对的账目（点击首页提示条），并附带 attention_months：
 * 本月及以前所有有待处理账目的月份和笔数（从早到晚），用于“去处理”和“其他月份还有 N 笔”。
 * now 为空时不附带（旧调用方式）。
 */
function svcListMonth(repo, month, filter, now) {
  if (!isMonthString(month)) throw UserError('月份格式不正确');
  var all = repo.list('entries');
  var lk = lookups_(repo, all);
  var list = all.filter(function (e) { return isLive(e) && e.month_ny === month; });
  if (filter === 'attention') {
    list = list.filter(function (e) { return entryStatus(e) !== STATUS.NORMAL; });
  }
  list.sort(function (a, b) { return a.occurred_at < b.occurred_at ? 1 : a.occurred_at > b.occurred_at ? -1 : 0; });
  var days = [];
  var byDate = {};
  list.forEach(function (e) {
    if (!byDate[e.date_ny]) {
      byDate[e.date_ny] = { date: e.date_ny, expense_subtotal_cents: 0, entries: [] };
      days.push(byDate[e.date_ny]);
    }
    var d = byDate[e.date_ny];
    if (e.type === 'expense' && e.amount_cents !== null) d.expense_subtotal_cents += e.amount_cents;
    d.entries.push(entryView_(e, lk));
  });
  // 本月汇总（只读）：口径与月报完全一致（退款抵扣、待补全不计金额只计数），且不受 filter 影响
  var rep = computeReport(all, repo.list('categories'), repo.list('income_sources'), month);
  var totals = {
    expense_cents: rep.expense.total_cents,
    income_cents: rep.income.total_cents,
    diff_cents: rep.comparison.diff_cents,
    pending_count: rep.pending_count
  };
  var out = { month: month, filter: filter || 'all', days: days, banner: bannerCounts(all, month), totals: totals };
  if (filter === 'attention' && now) out.attention_months = attentionMonths(all, monthNY(now));
  return out;
}

function svcGetEntry(repo, id) {
  var all = repo.list('entries');
  var e = findById_(all, id);
  if (!e) throw UserError('找不到这笔账目');
  return entryView_(e, lookups_(repo, all));
}

/**
 * 新建或修改账目。input.id 为空表示新建。
 * 返回保存后的账目视图。会同时更新受影响月份的“最后更新时间”（修改日期时前后两个月都会更新）。
 */
function svcSaveEntry(repo, input, now, newId, metadata) {
  var entries = repo.list('entries');
  var existing = input && input.id ? findById_(entries, input.id) : null;
  if (input && input.id && !existing) throw UserError('找不到这笔账目');
  if (existing && existing.deleted_at) throw UserError('这笔账目已删除，请先恢复');

  var result = validateEntryInput(input, existing, {
    categories: repo.list('categories'),
    sources: repo.list('income_sources'),
    entries: entries,
    newId: newId
  });
  if (result.newSource) {
    if (result.newSource.created) repo.insert('income_sources', result.newSource.source);
    else repo.update('income_sources', result.newSource.source.id, { archived: false });
  }

  var saved;
  var months = [result.fields.month_ny];
  if (existing) {
    saved = applyEntryEdit(existing, result.fields, now);
    var patch = {};
    Object.keys(result.fields).forEach(function (k) { patch[k] = saved[k]; });
    patch.updated_at = saved.updated_at;
    repo.update('entries', existing.id, patch);
    if (existing.month_ny !== saved.month_ny) months.push(existing.month_ny);
  } else {
    saved = buildManualEntry(result.fields, newId(), now);
    if (metadata) Object.keys(metadata).forEach(function (k) { saved[k] = metadata[k]; });
    repo.insert('entries', saved);
    svcOnEntryCreated_(repo, saved);     // 打卡：新建账目的这一天（费城时间）
    flagDupsSafely_(repo, saved, newId); // 与 Apple Pay 等其他渠道的账目疑似同一笔时，两笔都标“待核对重复”（spec 4.4）
  }
  touchMonths_(repo, months, now);
  return svcGetEntry(repo, saved.id);
}

function svcDeleteEntry(repo, id, now) {
  var e = findById_(repo.list('entries'), id);
  if (!e) throw UserError('找不到这笔账目');
  repo.update('entries', id, softDeleteEntry(e, now));
  svcAfterDeleteDup_(repo, e);          // “删除这一笔”：重复组里只剩一笔时，它不再标“待核对重复”
  touchMonths_(repo, [e.month_ny], now);
  return { ok: true };
}

function svcRestoreEntry(repo, id, now) {
  var e = findById_(repo.list('entries'), id);
  if (!e) throw UserError('找不到这笔账目（可能已超过 30 天被清除）');
  repo.update('entries', id, restoreEntryPatch(e, now));
  svcAfterRestoreDup_(repo, e);
  touchMonths_(repo, [e.month_ny], now);
  return svcGetEntry(repo, id);
}

/** 设置页“最近删除”：按删除时间倒序，附带自动清除日期。 */
function svcListDeleted(repo) {
  var all = repo.list('entries');
  var lk = lookups_(repo, all);
  return all.filter(function (e) { return !!e.deleted_at; })
    .sort(function (a, b) { return a.deleted_at < b.deleted_at ? 1 : -1; })
    .map(function (e) { return entryView_(e, lk); });
}

/** 每日清理：彻底删除“删除超过 30 天”的账目。processed_sources 不动（spec 4.5）。 */
function svcPurgeDeleted(repo, now) {
  var ids = selectPurgeIds(repo.list('entries'), now);
  if (ids.length) repo.removeByKeys('entries', ids);
  return { purged: ids.length };
}

/** 退款可关联的原交易：最近 365 天内未删除的普通支出（有金额）。 */
function svcRefundCandidates(repo, now) {
  var cutoff = new Date(now.getTime() - 365 * DAY_MS).toISOString();
  var all = repo.list('entries');
  var lk = lookups_(repo, all);
  return all.filter(function (e) {
    return isLive(e) && e.type === 'expense' && !e.is_refund && e.amount_cents !== null && e.occurred_at >= cutoff;
  }).sort(function (a, b) { return a.occurred_at < b.occurred_at ? 1 : -1; })
    .map(function (e) { return entryView_(e, lk); });
}

/** 月报：计算结果 + “生成于 / 最后更新于”。 */
function svcGetReport(repo, month, now) {
  if (!isMonthString(month)) throw UserError('月份格式不正确');
  var rep = computeReport(repo.list('entries'), repo.list('categories'), repo.list('income_sources'), month);
  var meta = repo.list('month_meta').filter(function (m) { return m.month === month; })[0];
  var current = monthNY(now);
  rep.is_current_month = month === current;
  rep.is_future_month = month > current;
  rep.generated_on = rep.is_current_month || rep.is_future_month ? null : addMonths(month, 1) + '-01';
  rep.last_changed_local = meta && meta.last_changed_at ? localNY(meta.last_changed_at) : null;
  // 本月预算小结（spec 7A.2 / PRD 6A.5）：使用该月当时有效的预算；没有任何预算时为 null（界面不显示）
  var view = computeBudgetView(repo.list('entries'), repo.list('categories'), listOptional_(repo, 'budgets'), month,
    readNearPct(listOptional_(repo, 'settings')));
  rep.budget = view.has_any ? { view: view, summary: budgetSummarySentence(view) } : null;
  return rep;
}

// ---- 预算（spec 7A.1 / 7A.2） ----

/** 预算页：某月的预算总览。只有当前月份可以修改；过去月份显示当时有效的预算（只读）。 */
function svcGetBudgets(repo, month, now) {
  if (!isMonthString(month)) throw UserError('月份格式不正确');
  var current = monthNY(now);
  var ready = budgetReady_(repo);
  var view = computeBudgetView(repo.list('entries'), repo.list('categories'), listOptional_(repo, 'budgets'), month,
    readNearPct(listOptional_(repo, 'settings')));
  var L = daysInMonth(month);
  view.current_month = current;
  view.is_current_month = month === current;
  view.is_future_month = month > current;
  view.editable = month === current && ready;
  view.ready = ready;
  view.days_in_month = L;
  view.days_left = month === current ? L - nyParts(now).d : null;   // 今天算作已过去（spec 7A.2 时间进度）
  return view;
}

/**
 * 设置 / 修改 / 取消一项预算（只针对当前费城月份，月份由服务器决定，网页不能指定）。
 * amount 为空 = 从本月起取消这项预算。返回本月的预算总览（含 D10 提示）。
 */
function svcSetBudget(repo, scope, amount, now, newId) {
  requireTable_(repo, 'budgets');
  validateBudgetScope(repo.list('categories'), scope);
  var cents = parseBudgetAmount(amount);
  var current = monthNY(now);
  applyBudgetPlan_(repo, planBudgetChange(repo.list('budgets'), scope, cents, current, now, newId));
  return svcGetBudgets(repo, current, now);
}

function applyBudgetPlan_(repo, plan) {
  if (plan.insert) repo.insert('budgets', plan.insert);
  else if (plan.update) repo.update('budgets', plan.update.id, plan.update.patch);
}

/** 我的 → 预算提醒比例（50–100 的整数）。 */
function svcSetBudgetNearPct(repo, pct) {
  requireTable_(repo, 'settings');
  var n = validateNearPct(pct);
  var has = repo.list('settings').some(function (r) { return r.key === BUDGET_NEAR_PCT_KEY; });
  if (has) repo.update('settings', BUDGET_NEAR_PCT_KEY, { value: String(n) });
  else repo.insert('settings', { key: BUDGET_NEAR_PCT_KEY, value: String(n) });
  return { budget_near_pct: n };
}

// ---- 账单（报表 → 账单） ----

/** 月账单：某年每个月的收入 / 支出 / 结余（只到当前月份），以及可选的年份列表。 */
function svcGetMonthBills(repo, year, now) {
  if (!/^\d{4}$/.test(String(year))) throw UserError('年份格式不正确');
  var current = monthNY(now);
  var entries = repo.list('entries');
  var out = computeMonthBills(entries, repo.list('categories'), repo.list('income_sources'), String(year), current);
  var years = billYears(entries, current);
  if (years.indexOf(current.slice(0, 4)) < 0) years.unshift(current.slice(0, 4));
  out.years = years;
  out.current_month = current;
  return out;
}

/** 年账单：每个有账目的年份一行，以及合计。 */
function svcGetYearBills(repo, now) {
  var current = monthNY(now);
  var out = computeYearBills(repo.list('entries'), repo.list('categories'), repo.list('income_sources'), current);
  out.current_month = current;
  return out;
}

function touchMonths_(repo, months, now) {
  var existing = {};
  repo.list('month_meta').forEach(function (m) { existing[m.month] = true; });
  var seen = {};
  months.forEach(function (m) {
    if (!m || seen[m]) return;
    seen[m] = true;
    if (existing[m]) repo.update('month_meta', m, { last_changed_at: now.toISOString() });
    else repo.insert('month_meta', { month: m, last_changed_at: now.toISOString() });
  });
}

function svcAddCategory(repo, type, name, newId) {
  var plan = planAddCategory(repo.list('categories'), type, name, newId);
  if (plan.create) { repo.insert('categories', plan.create); return plan.create; }
  repo.update('categories', plan.reactivate.id, { archived: false });
  return findById_(repo.list('categories'), plan.reactivate.id);
}

/**
 * 删除类别 = 归档。若这个类别本月有预算，从本月起写入“空金额”取消它（spec 7A.1）；过去月份不受影响。
 * 以后重新启用这个类别时预算保持取消，需要重新填写。budgets 表还不存在时不可能有预算，跳过。
 */
function svcArchiveCategory(repo, id, now, newId) {
  var cat = findById_(repo.list('categories'), id);
  checkArchiveCategory(cat);
  repo.update('categories', id, { archived: true });
  if (cat.type === 'expense' && (!repo.has || repo.has('budgets'))) {
    applyBudgetPlan_(repo, planBudgetChange(repo.list('budgets'), id, null, monthNY(now), now, newId));
  }
  return { ok: true };
}

function svcAddSource(repo, name, newId) {
  var found = findOrCreateSource(repo.list('income_sources'), name, newId);
  if (found.created) repo.insert('income_sources', found.source);
  else if (found.reactivated) repo.update('income_sources', found.source.id, { archived: false });
  return findById_(repo.list('income_sources'), found.source.id);
}

function svcArchiveSource(repo, id) {
  var src = findById_(repo.list('income_sources'), id);
  if (!src) throw UserError('找不到这个来源');
  repo.update('income_sources', id, { archived: true });
  return { ok: true };
}

/**
 * 手机验收用：写入一笔“模拟的自动记录、金额为空”的支出（docs/checklist-slice1.md 的“待补全”场景）。
 * 手动记录金额必填，所以只能这样产生待补全账目；商家写明“测试”，验收后可直接删除。
 */
function svcInsertTestPending(repo, localDatetime, now, newId) {
  var d = parseLocalNY(localDatetime);
  var cat = repo.list('categories').filter(function (c) { return c.system_key === UNCATEGORIZED_KEY; })[0];
  var id = newId();
  repo.insert('entries', {
    id: id, type: 'expense', amount_cents: null, occurred_at: d.toISOString(), month_ny: monthNY(d), date_ny: dateNY(d),
    category_id: cat.id, income_source_id: null, merchant: '测试：模拟自动记录', note: '验收测试数据，可删除',
    channel: 'apple_pay', platform: null, is_refund: false, refund_of: null, flag_dup: false, dup_group: null,
    flag_amount_review: false, source_key: 'test:pending:' + id, order_ref: null,
    created_at: now.toISOString(), updated_at: now.toISOString(), deleted_at: null
  });
  svcOnEntryCreated_(repo, { created_at: now.toISOString() });   // 模拟的自动入账同样算打卡
  touchMonths_(repo, [monthNY(d)], now);
  return svcGetEntry(repo, id);
}

// ---- 打卡（Task 06） ----

/** 某张后来新增的工作表是否已经存在（内存版 repo 没有 has 时视为存在）。 */
function tableReady_(repo, table) {
  return !repo.has || repo.has(table);
}

/** 记录一天的打卡（按 created_at 的费城日期）；这一天已有就什么都不写。checkins 表还不存在时跳过。 */
function svcRecordCheckin_(repo, createdAtIso) {
  if (!tableReady_(repo, 'checkins')) return null;
  var day = checkinDateOf(createdAtIso);
  if (!day) return null;
  if (repo.list('checkins').some(function (r) { return r.date_ny === day; })) return day;
  repo.insert('checkins', { date_ny: day, first_entry_at: new Date(createdAtIso).toISOString() });
  return day;
}

/** 跨渠道重复检查出错时只记日志：账目已经保存好了，不能因此显示“保存失败”。 */
function flagDupsSafely_(repo, entry, newId) {
  try {
    svcFlagCrossChannelDups_(repo, entry, newId);
  } catch (e) {
    console.error('重复检查失败：' + (e && e.stack ? e.stack : e));
  }
}

/**
 * 每新建一笔账目之后调用（手动保存新账目、自动入账：Gmail / Apple Pay 收件箱整理以后也必须调用这里）。
 * 打卡失败不能让已经写好的账目显示“保存失败”（否则你可能再点一次，记成两笔），所以这里只记日志；
 * 漏记的打卡在下次重新运行 setupLedger 时会按账目的创建时间补上。
 */
function svcOnEntryCreated_(repo, entry) {
  try {
    svcRecordCheckin_(repo, entry.created_at);
  } catch (e) {
    console.error('记录打卡失败：' + (e && e.stack ? e.stack : e));
  }
}

/** setupLedger：按已有账目的创建时间补上缺少的打卡日期（只追加缺少的天，不改动已有行；重复运行不变）。返回补上的天数。 */
function svcBackfillCheckins(repo) {
  if (!tableReady_(repo, 'checkins')) return 0;
  var rows = planCheckinBackfill(repo.list('entries'), repo.list('checkins'));
  rows.forEach(function (r) { repo.insert('checkins', r); });
  return rows.length;
}

/** 我的页的打卡概况；表不存在时 ready = false，数字都为 0。 */
function svcCheckinView_(repo, now) {
  var ready = tableReady_(repo, 'checkins');
  var dates = ready ? repo.list('checkins').map(function (r) { return r.date_ny; }) : [];
  var view = checkinSummary(dates, dateNY(now));
  view.ready = ready;
  return view;
}

// ---- 小助手（spec 7A.3–7A.5） ----

function assistantReady_(repo) {
  return tableReady_(repo, 'assistant_messages') && tableReady_(repo, 'assistant_state');
}

/** 储蓄提醒只在当前月仍超出可存金额时可见；保留原始消息供既有清理流程处理。 */
function assistantMessageRows_(repo, now) {
  if (!assistantReady_(repo)) return [];
  var rows = repo.list('assistant_messages');
  if (!rows.some(function (m) { return m.skill_id === 'savings_affordability'; })) return rows;
  var month = monthNY(now);
  var cutoff = new Date(now.getTime() - ASSISTANT_SHOW_DAYS * DAY_MS).toISOString();
  var forecast = savingsReady_(repo) ? svcSavingsForecast_(repo, now) : null;
  var eligible = savingsAffordabilityEligible_(forecast, month);
  return rows.filter(function (m) {
    return m.skill_id !== 'savings_affordability' || (eligible && m.month === month && m.created_at && m.created_at >= cutoff);
  });
}

function assistantUnreadCount_(repo, now) {
  return assistantMessageRows_(repo, now).filter(function (m) { return !m.read_at; }).length;
}

/** 快照需要的账本数据（只在服务器内部使用；快照本身只保留汇总）。 */
function assistantData_(repo, now) {
  return {
    entries: repo.list('entries'),
    categories: repo.list('categories'),
    budgets: listOptional_(repo, 'budgets'),
    settings: listOptional_(repo, 'settings'),
    checkins: tableReady_(repo, 'checkins') ? repo.list('checkins') : null,
    rate_limited_markers: svcRateMarkersForAssistant_(repo),  // Apple Pay 收件口的限流标记 [{at, count}]（切片 3）
    pending_mail_count: svcPendingMailCount_(repo),           // D16“待查看邮件”数（切片 2）
    savings_forecast: savingsReady_(repo) ? svcSavingsForecast_(repo, now) : null
  };
}

/**
 * runAssistantRules(now)：在脚本锁内运行全部提醒规则，写入新消息和新状态。
 * - assistant_messages / assistant_state 还不存在（还没重新运行 setupLedger）时直接跳过：不写、不建表、不报错；
 * - 同样的数据重复运行不会产生第二条消息（状态 + 只发一次的去重键）；
 * - 先写状态、再写消息：万一中途出错，最多少一条提醒，而不会重复提醒。
 * 返回 {ran, added}。
 */
function svcRunAssistantRules(repo, now, newId) {
  if (!assistantReady_(repo)) return { ran: false, added: 0 };
  var stateRows = repo.list('assistant_state');
  var stateMap = {};
  stateRows.forEach(function (r) { stateMap[r.state_key] = r.value; });
  var res = runSkills(buildSnapshot(assistantData_(repo, now), now), stateMap);
  var ts = now.toISOString();
  Object.keys(res.changes).forEach(function (k) {
    var value = String(res.changes[k]);
    if (Object.prototype.hasOwnProperty.call(stateMap, k)) {
      if (stateMap[k] !== value) repo.update('assistant_state', k, { value: value, updated_at: ts });
    } else {
      repo.insert('assistant_state', { state_key: k, value: value, updated_at: ts });
    }
  });
  var existingKeys = {};
  var byKey = {};
  repo.list('assistant_messages').forEach(function (m) {
    if (m.dedup_key) { existingKeys[m.dedup_key] = true; byKey[m.dedup_key] = m; }
  });
  var added = 0;
  res.messages.forEach(function (m) {
    if (m.upsert && byKey[m.dedup_key]) {
      // 同一件事的新情况（例如限流标记的被拒次数变多）：更新原来那条消息，并重新设为未读（红点再次出现）
      repo.update('assistant_messages', byKey[m.dedup_key].id, {
        text: m.text, created_at: ts, read_at: null, items_json: m.items && m.items.length ? JSON.stringify(m.items) : null
      });
      added++;
      return;
    }
    if (m.once && existingKeys[m.dedup_key]) return;   // 双保险：只发一次的消息，同一个去重键只存一条
    existingKeys[m.dedup_key] = true;
    repo.insert('assistant_messages', {
      id: newId(), created_at: ts, skill_id: m.skill_id, dedup_key: m.dedup_key, month: m.month, text: m.text,
      action: m.action, read_at: null, items_json: m.items && m.items.length ? JSON.stringify(m.items) : null
    });
    added++;
  });
  return { ran: true, added: added };
}

function parseItems_(json) {
  if (!json) return [];
  try {
    var v = JSON.parse(json);
    return Array.isArray(v) ? v.filter(function (x) { return x && typeof x.label === 'string' && typeof x.amount_cents === 'number'; }) : [];
  } catch (e) {
    return [];
  }
}

/** 对话窗口：最近 30 天的消息（旧的在上、新的在下）、问题按钮、未读数。只读。 */
function svcGetAssistant(repo, now) {
  var ready = assistantReady_(repo);
  var cutoff = new Date(now.getTime() - ASSISTANT_SHOW_DAYS * DAY_MS).toISOString();
  var rows = assistantMessageRows_(repo, now);
  var list = rows.map(function (m, i) { return { m: m, i: i }; })
    .filter(function (x) { return x.m.created_at && x.m.created_at >= cutoff; })
    .sort(function (a, b) { return a.m.created_at < b.m.created_at ? -1 : a.m.created_at > b.m.created_at ? 1 : a.i - b.i; })
    .map(function (x) {
      var m = x.m;
      return {
        id: m.id, skill_id: m.skill_id, created_local: localNY(m.created_at), text: m.text,
        items: parseItems_(m.items_json), action: m.action || null, mood: assistantMood(m.skill_id), unread: !m.read_at
      };
    });
  return { ready: ready, messages: list, questions: assistantQuestions(), unread_count: rows.filter(function (m) { return !m.read_at; }).length };
}

/** 问题按钮：即时计算回答，不保存、不产生红点。只读。 */
function svcAskAssistant(repo, skillId, now) {
  return answerQuestion(String(skillId || ''), buildSnapshot(assistantData_(repo, now), now));
}

/** 打开对话窗口：把所有未读消息标为已读（红点消失）。表不存在时什么都不做。 */
function svcMarkAssistantRead(repo, now) {
  if (!assistantReady_(repo)) return { unread_count: 0, marked: 0 };
  var ts = now.toISOString();
  var marked = 0;
  repo.list('assistant_messages').forEach(function (m) {
    if (m.read_at) return;
    repo.update('assistant_messages', m.id, { read_at: ts });
    marked++;
  });
  return { unread_count: 0, marked: marked };
}

/** 每日清理：删除 90 天前的小助手消息（D11）。打卡和 assistant_state 不清理。 */
function svcPurgeAssistantMessages(repo, now) {
  if (!tableReady_(repo, 'assistant_messages')) return { purged: 0 };
  var limit = now.getTime() - ASSISTANT_KEEP_DAYS * DAY_MS;
  var ids = repo.list('assistant_messages').filter(function (m) {
    var t = new Date(m.created_at).getTime();
    return !isNaN(t) && t < limit;
  }).map(function (m) { return m.id; });
  if (ids.length) repo.removeByKeys('assistant_messages', ids);
  return { purged: ids.length };
}
