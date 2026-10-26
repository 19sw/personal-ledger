/**
 * DoorDash 收据规则（spec 6.5 表格第 1 行）。
 * 【全部未核实，待 G1 确认】发件域名、主题关键词、总额标签都是按常见格式猜的；G1 核对后直接改这里的常量。
 */
var DOORDASH_RULES_ = {
  domains: ['doordash.com'],
  totalLabels: ['Total Charged', 'Order Total', 'Total'].concat(['Grand Total', 'Amount Paid', '总计', '实付']),
  excludeLabels: ['Subtotal', 'Sub-total', 'Sub total'].concat(['小计', '优惠', '折扣', 'Total Savings']),
  refundLabels: ['Refund Total', 'Total Refund', 'Refund Amount', 'Refunded', 'Refund'],
  subject: {
    never: [/dashpass/i, /gift\s*card/i],
    refund: /refund|refunded|credit(ed)? (has been |was )?(issued|applied)/i,
    promo: /\d+\s*%\s*off|% off|\bdeals?\b|\bpromo|\boffers?\b|free delivery|\bsave \$/i,
    receipt: /receipt|order confirmation|\byour (?:[\w-]+ )?order from\b|订单|收据/i   // 不用单独的“order from”：营销邮件常写“Order from … tonight”
  },
  orderLinks: [/doordash\.com\/orders\/([A-Za-z0-9-]{4,64})/i],
  orderText: [/order\s*(?:#|no\.?|number|id)\s*:?\s*#?\s*([A-Za-z0-9-]{4,64})/i],
  confirmation: /order confirmation/i
};

/**
 * DoorDash 的订单确认邮件写的是 “estimated total”（下单后小费还能改）。2026-10-26 你决定（G1 第二次试运行后）：
 * 标题是订单确认、标题不像广告或退款、正文里唯一的不确定说法是 estimated total 时，照常记账，但标为“待核对金额”。
 */
function doordashEstimatedConfirmation_(subject, text) {
  var r = DOORDASH_RULES_.subject;
  if (!DOORDASH_RULES_.confirmation.test(subject)) return false;
  if (r.never.some(function (re) { return textHas(subject, re); }) || textHas(subject, r.promo) || textHas(subject, RECEIPT_PROMO_TEXT_) || textHas(subject, r.refund)) return false;
  return onlyEstimatedTotal_(subject, text);
}

var RECEIPT_PLATFORM_DOORDASH = {
  id: 'doordash',
  displayName: 'DoorDash',
  enabled: true,
  support_status: 'unverified',
  category: '餐饮',
  gmailQuery: ['from:(doordash.com)'],
  merchantAliases: ['doordash'],
  matchSender: function (from) { return senderDomainIn(from, DOORDASH_RULES_.domains); },
  classify: function (subject, text) {
    var kind = classifyBySubject(subject, text, Object.assign({
      amountLabels: DOORDASH_RULES_.totalLabels.concat(DOORDASH_RULES_.refundLabels)
    }, DOORDASH_RULES_.subject));
    return kind === 'uncertain' && doordashEstimatedConfirmation_(subject, text) ? 'receipt' : kind;
  },
  amountIsEstimate: function (subject, text) { return doordashEstimatedConfirmation_(subject, text); },
  extractTotal: function (text) { return extractLabeledAmount(text, DOORDASH_RULES_.totalLabels, DOORDASH_RULES_.excludeLabels, { finalTotal: true }); },
  extractRefund: function (text) { return extractLabeledAmount(text, DOORDASH_RULES_.refundLabels, DOORDASH_RULES_.excludeLabels); },
  extractOrderRef: function (text, links) { return findOrderRef(text, links, DOORDASH_RULES_.orderLinks, DOORDASH_RULES_.orderText); }
};
