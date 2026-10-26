/**
 * 账目状态：不单独保存，而是由字段计算出来（spec 4.1）。
 * 优先级：待补全 > 待核对金额 > 待核对重复 > 正常。
 */

var STATUS = {
  PENDING: 'pending',             // 待补全（金额未知）
  AMOUNT_REVIEW: 'amount_review', // 待核对金额
  DUP_REVIEW: 'dup_review',       // 待核对重复
  NORMAL: 'normal'                // 正常
};

var STATUS_LABEL = {
  pending: '待补全',
  amount_review: '待核对金额',
  dup_review: '待核对重复',
  normal: '正常'
};

function entryStatus(e) {
  if (e.amount_cents === null || e.amount_cents === undefined) return STATUS.PENDING;
  if (e.flag_amount_review) return STATUS.AMOUNT_REVIEW;
  if (e.flag_dup) return STATUS.DUP_REVIEW;
  return STATUS.NORMAL;
}

function isLive(e) {
  return !e.deleted_at;
}

/**
 * 首页提示条：“本月有 N 笔待补全、M 笔待核对”。
 * 只统计该月未删除的账目；待核对 = 待核对金额 + 待核对重复（按上面的优先级，每笔只算一次）。
 */
function bannerCounts(entries, month) {
  var pending = 0, review = 0;
  entries.forEach(function (e) {
    if (!isLive(e) || e.month_ny !== month) return;
    var st = entryStatus(e);
    if (st === STATUS.PENDING) pending++;
    else if (st === STATUS.AMOUNT_REVIEW || st === STATUS.DUP_REVIEW) review++;
  });
  return { pending: pending, review: review };
}
