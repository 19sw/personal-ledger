/**
 * Apple Pay 收件箱整理、跨渠道疑似重复、渠道状态（spec 4.4、5.1 第 4 步、5.3；PRD 6.1、6.2、6.4）。
 * 与 service.js 一样只通过 repo 接口读写「账本」；「收件箱」的行由调用方（web.js / jobs.js）读好后传进来。
 * 调用方负责脚本锁。
 */

var CHANNEL_ERROR_TEXT = {
  INBOX_OPEN_FAILED: '打不开「收件箱」表格（检查脚本属性 INBOX_SPREADSHEET_ID 和表格是否还在）',
  INBOX_SHEET_MISSING: '「收件箱」里没有 inbox 工作表（请在收件口项目中运行 setupInbox）',
  INBOX_HEADER_MISMATCH: '「收件箱」inbox 工作表的表头不对（请不要手动修改这张表）',
  ROW_FAILED: '有收件行整理失败，下次会再试',
  NO_UNCATEGORIZED: '找不到“未分类”类别（请重新运行 setupLedger）',
  PROCESS_FAILED: '整理收件箱时出错，下次会再试'
};

/** 错误对象上带一个错误代码（只记录代码，不记录可能含 ID 或内容的错误信息）。 */
function inboxError_(code) {
  var e = new Error(code);
  e.inboxCode = code;
  return e;
}

/**
 * 整理收件箱（spec 5.1 第 4 步）。rows = 收件箱的全部行（store.js 的 inboxRepo_.list()）。
 * 对每个交易行：
 *   - 凭据 applepay:evt:<event_id> 已在 processed_sources → 跳过（重复发送、已删除的自动记录都不会再出现）；
 *   - 账本里已有这个凭据的账目、但 processed_sources 没有（上次在两步之间中断）→ 只补写凭据，不再新建；
 *   - 否则新建一笔支出（未分类、apple_pay），写凭据，记打卡，做跨渠道重复检查，更新月份时间。
 * 先写账目再写凭据：即使中途中断，下次也会通过上面第二条补齐，不会多记也不会漏记。
 * 同时把限流标记同步到 apple_pay_markers。返回 {created, repaired, errors, stale_count, markers_changed}。
 */
function svcProcessInbox(repo, rows, now, newId) {
  var processed = {};
  repo.list('processed_sources').forEach(function (p) { processed[p.source_key] = true; });
  var todo = unprocessedInboxRows(rows, processed);
  var out = { created: 0, repaired: 0, errors: 0, stale_count: 0, markers_changed: false, error_code: null };
  var cat = todo.length ? repo.list('categories').filter(function (c) { return c.system_key === UNCATEGORIZED_KEY; })[0] : null;
  if (todo.length && !cat) {
    out.errors = todo.length;                    // 没有“未分类”就不能入账：这些行留在收件箱里，下次再试
    out.error_code = 'NO_UNCATEGORIZED';
  } else if (todo.length) {
    var bySource = {};
    repo.list('entries').forEach(function (e) { if (e.source_key) bySource[e.source_key] = e; });
    var months = [];
    var ts = now.toISOString();
    todo.forEach(function (row) {
      var key = applePaySourceKey(row.event_id);
      if (processed[key]) return;            // 同一次整理中，收件箱里出现两行相同的 event_id
      try {
        var existing = bySource[key];
        if (existing) {
          repo.insert('processed_sources', { source_key: key, entry_id: existing.id, outcome: 'created', processed_at: ts });
          processed[key] = true;
          out.repaired++;
          return;
        }
        var entry = buildApplePayEntry(row, cat.id, newId(), now);
        repo.insert('entries', entry);
        bySource[key] = entry;
        repo.insert('processed_sources', { source_key: key, entry_id: entry.id, outcome: 'created', processed_at: ts });
        processed[key] = true;
        out.created++;
        months.push(entry.month_ny);                     // 先记下月份：后面无论怎样都会更新“最后更新时间”
        svcOnEntryCreated_(repo, entry);                 // 打卡（自动入账也算）
        flagDupsSafely_(repo, entry, newId);             // 跨渠道疑似重复（spec 4.4）；出错只记日志，账目和凭据已写好
      } catch (e) {
        out.errors++;
        out.error_code = 'ROW_FAILED';
        console.error('收件行整理失败：' + (e && e.name ? e.name : 'Error'));
      }
    });
    touchMonths_(repo, months, now);
  }
  out.markers_changed = svcSyncRateMarkers_(repo, inboxRateMarkers(rows), now);
  out.stale_count = countStaleInboxRows(rows, processed, now);
  return out;
}

/** 把收件箱的限流标记写进 apple_pay_markers（新标记插入，被拒次数变多时更新）。返回是否有变化。 */
function svcSyncRateMarkers_(repo, markers, now) {
  if (!markers.length || !tableReady_(repo, 'apple_pay_markers')) return false;
  var have = {};
  repo.list('apple_pay_markers').forEach(function (m) { have[m.marker_at] = m; });
  var changed = false;
  markers.forEach(function (m) {
    var cur = have[m.marker_at];
    if (!cur) {
      repo.insert('apple_pay_markers', { marker_at: m.marker_at, rejected_count: m.rejected_count, updated_at: now.toISOString() });
      have[m.marker_at] = m;
      changed = true;
    } else if (m.rejected_count > (cur.rejected_count || 0)) {
      repo.update('apple_pay_markers', m.marker_at, { rejected_count: m.rejected_count, updated_at: now.toISOString() });
      changed = true;
    }
  });
  return changed;
}

/** 小助手用的限流标记：[{at, count}]。表不存在时为空。 */
function svcRateMarkersForAssistant_(repo) {
  if (!tableReady_(repo, 'apple_pay_markers')) return [];
  return repo.list('apple_pay_markers').map(function (m) { return { at: m.marker_at, count: m.rejected_count || 1 }; })
    .sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
}

// ---------------- 跨渠道疑似重复 ----------------

/**
 * 新建账目后调用（Apple Pay 整理、手动新建）：与其他渠道金额相同、24 小时内、商家相近、没被“两笔都保留”过的账目
 * 一起标“待核对重复”，共享同一个 dup_group。不合并、不删除（PRD 6.2）。返回被标记的其他账目数。
 */
function svcFlagCrossChannelDups_(repo, entry, newId) {
  var all = repo.list('entries');
  var self = findById_(all, entry.id) || entry;
  return svcFlagDupGroup_(repo, self, findDupCandidates(self, all, repo.list('dup_dismissed')), newId);
}

/**
 * 把 self 和 cands 标为同一组“待核对重复”（跨渠道重复、外卖收据的 D7 和重复退款共用）：
 * 沿用已有的组号，没有就新建；已在某一组里的账目不拆散原来的组。返回 cands 的数量。
 */
function svcFlagDupGroup_(repo, self, cands, newId) {
  if (!cands.length) return 0;
  var group = self.dup_group || null;
  cands.forEach(function (c) { if (!group && c.dup_group) group = c.dup_group; });
  if (!group) group = 'dup-' + newId();
  cands.concat([self]).forEach(function (e) {
    if (e.dup_group) {                          // 已在某一组里：不拆散原来的组，只确保标记还在
      if (!e.flag_dup) repo.update('entries', e.id, { flag_dup: true });
      return;
    }
    repo.update('entries', e.id, { flag_dup: true, dup_group: group });
  });
  return cands.length;
}

/** 同一组里其他未删除的账目。 */
function dupGroupMembers_(all, group, exceptId) {
  return all.filter(function (e) { return e.dup_group === group && e.id !== exceptId && isLive(e); });
}

/**
 * “两笔都保留”（PRD 第 4 节）：这一组里所有未删除的账目两两写入 dup_dismissed，并清除“待核对重复”。
 * 以后同样的两笔不会再被标为重复。
 */
function svcKeepDuplicates(repo, id, now) {
  var all = repo.list('entries');
  var e = findById_(all, id);
  if (!e) throw UserError('找不到这笔账目');
  if (e.deleted_at) throw UserError('这笔账目已删除');
  if (!e.flag_dup || !e.dup_group) throw UserError('这笔账目没有被标为可能重复');
  var members = [e].concat(dupGroupMembers_(all, e.dup_group, e.id));
  var have = {};
  repo.list('dup_dismissed').forEach(function (r) { have[r.pair_key] = true; });
  for (var i = 0; i < members.length; i++) {
    for (var j = i + 1; j < members.length; j++) {
      var k = dupPairKey(members[i].id, members[j].id);
      if (have[k]) continue;
      have[k] = true;
      var ids = k.split('|');
      repo.insert('dup_dismissed', { pair_key: k, entry_a: ids[0], entry_b: ids[1] });
    }
  }
  var months = [];
  members.forEach(function (m) {
    repo.update('entries', m.id, { flag_dup: false, dup_group: null, updated_at: now.toISOString() });
    months.push(m.month_ny);
  });
  touchMonths_(repo, months, now);
  return svcGetEntry(repo, id);
}

/**
 * 删除一笔“待核对重复”的账目（= 选择“删除这一笔”）之后：同组里如果只剩一笔未删除的，它就不再是重复，清除标记。
 * 被删除的账目自己保留标记和组号，恢复时用（svcAfterRestoreDup_）。
 */
function svcAfterDeleteDup_(repo, deleted) {
  if (!deleted.dup_group) return;
  var all = repo.list('entries');
  var rest = dupGroupMembers_(all, deleted.dup_group, deleted.id);
  if (rest.length === 1 && rest[0].flag_dup) repo.update('entries', rest[0].id, { flag_dup: false });
}

/** 恢复一笔曾在重复组里的账目：组里还有没被“两笔都保留”过的未删除账目 → 两边重新标“待核对重复”；否则清除它自己的标记。 */
function svcAfterRestoreDup_(repo, restored) {
  if (!restored.dup_group) return;
  var all = repo.list('entries');
  var dismissed = {};
  repo.list('dup_dismissed').forEach(function (r) { dismissed[r.pair_key] = true; });
  var partners = dupGroupMembers_(all, restored.dup_group, restored.id).filter(function (o) {
    return !dismissed[dupPairKey(restored.id, o.id)];
  });
  if (!partners.length) {
    if (restored.flag_dup) repo.update('entries', restored.id, { flag_dup: false });
    return;
  }
  if (!restored.flag_dup) repo.update('entries', restored.id, { flag_dup: true });
  partners.forEach(function (o) { if (!o.flag_dup) repo.update('entries', o.id, { flag_dup: true }); });
}

// ---------------- 渠道状态（PRD 6.4） ----------------

/**
 * 记录一次运行结果。result = {ok, created, error_code, stale_count?, latency_sec?}。channel_status 表不存在时跳过。
 * 只写错误代码和固定的说明文字，不写错误详情。
 */
function svcRecordChannelRun_(repo, channel, now, result) {
  if (!tableReady_(repo, 'channel_status')) return;
  var ts = now.toISOString();
  var patch = { last_run_at: ts };
  if (result.ok) patch.last_success_at = ts;
  if (result.created > 0) patch.last_entry_at = ts;
  if (result.error_code) {
    patch.last_error_at = ts;
    patch.last_error_code = result.error_code;
    patch.last_error_text = CHANNEL_ERROR_TEXT[result.error_code] ||
      (typeof RECEIPT_ERROR_TEXT !== 'undefined' && RECEIPT_ERROR_TEXT[result.error_code]) || '出错了';
  }
  if (typeof result.stale_count === 'number') patch.stale_count = result.stale_count;
  if (typeof result.latency_sec === 'number') patch.last_latency_sec = result.latency_sec;   // 外卖收据：邮件到达 → 入账的秒数
  var has = repo.list('channel_status').some(function (r) { return r.channel === channel; });
  if (has) repo.update('channel_status', channel, patch);
  else repo.insert('channel_status', Object.assign({ channel: channel }, patch));
}

function channelStatusRow_(repo, channel) {
  if (!tableReady_(repo, 'channel_status')) return null;
  return repo.list('channel_status').filter(function (r) { return r.channel === channel; })[0] || null;
}

/** 刚整理过（throttleMs 毫秒内成功过）就不必在打开网页时再整理一次。 */
function svcInboxRanRecently_(repo, now, throttleMs) {
  var row = channelStatusRow_(repo, 'apple_pay');
  if (!row || !row.last_success_at || !row.last_run_at || row.last_success_at !== row.last_run_at) return false;
  var t = new Date(row.last_success_at).getTime();
  return !isNaN(t) && now.getTime() - t >= 0 && now.getTime() - t < throttleMs;
}

/**
 * 首页和“我的 → Apple Pay 自动记账”显示的状态。configured = 是否设置了收件箱（脚本属性）。
 * 没有设置时：功能关闭，不报错、不显示警告。
 * warnings（红色提示）：最近 7 天的限流标记、超过 7 天未整理的收件行、最近一次运行出错（且之后没有成功过）。
 */
function svcApplePayStatus(repo, now, configured) {
  var ready = tableReady_(repo, 'channel_status') && tableReady_(repo, 'apple_pay_markers');
  var view = { configured: !!configured, ready: ready, last_run_local: null, last_success_local: null, last_entry_local: null,
    error: null, stale_count: 0, markers: [], warnings: [] };
  if (!configured) return view;
  var row = channelStatusRow_(repo, 'apple_pay');
  if (row) {
    view.last_run_local = row.last_run_at ? localNY(row.last_run_at) : null;
    view.last_success_local = row.last_success_at ? localNY(row.last_success_at) : null;
    view.last_entry_local = row.last_entry_at ? localNY(row.last_entry_at) : null;
    view.stale_count = row.stale_count || 0;
    if (row.last_error_at && (!row.last_success_at || row.last_error_at >= row.last_success_at)) {
      view.error = { code: row.last_error_code, text: row.last_error_text, local: localNY(row.last_error_at) };
    }
  }
  var since = new Date(now.getTime() - RATE_WARN_DAYS * DAY_MS).toISOString();
  view.markers = svcRateMarkersForAssistant_(repo).filter(function (m) { return m.at >= since; })
    .map(function (m) { return { local: markerLabel(m.at), count: m.count, text: rateLimitedText(m.at, m.count) }; });
  view.markers.forEach(function (m) { view.warnings.push(m.text); });
  if (view.stale_count > 0) {
    view.warnings.push('Apple Pay 收件箱有 ' + view.stale_count + ' 笔超过 7 天还没整理成账目，30 天后会被清除，请到“我的 → Apple Pay 自动记账”查看');
  }
  if (view.error) view.warnings.push('Apple Pay 自动记账出错：' + view.error.text);
  return view;
}
