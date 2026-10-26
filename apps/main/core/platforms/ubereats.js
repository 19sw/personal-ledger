/**
 * Uber Eats 收据规则（spec 6.5 表格第 2 行；D14）。
 * Uber 打车和 Uber Eats 来自同一个域名，所以**只看邮件头（主题、发件人显示名）**判断是不是 Uber Eats：
 * 正文里的“Uber Eats”字样（例如打车收据页脚的广告）不算数。打车收据、Uber One、Uber Cash、促销一律 other；
 * 看不出是外卖还是打车、但有金额的 → uncertain（D16：不入账，列入“待查看邮件”）。
 * 【全部未核实，待 G1 确认】
 */
var UBEREATS_RULES_ = {
  domains: ['uber.com'],
  eatsHeader: /uber\s*eats/i,
  totalLabels: ['Total Charged', 'Order Total', 'Total', '总计'].concat(['Grand Total', 'Amount Paid', '总计', '实付']),
  excludeLabels: ['Subtotal', 'Sub-total', 'Sub total'].concat(['小计', '优惠', '折扣', 'Total Savings']),
  refundLabels: ['Refund Total', 'Total Refund', 'Refund Amount', 'Refunded', 'Refund'],
  never: /uber\s*one|uber\s*cash|gift\s*card|membership|会员/i,
  ride: /\btrips?\b|\brid(e|es|ing)\b|行程|乘车|打车/i,
  refund: /refund|refunded|退款/i,
  promo: /\d+\s*%\s*off|% off|\bdeals?\b|\bpromo|\boffers?\b|free delivery|优惠|折扣/i,
  receipt: /receipt|收据|order (with|from|confirmation)|订单/i,
  orderLinks: [/ubereats\.com\/[^\s"']*?orders?\/([A-Za-z0-9-]{4,64})/i],
  orderText: [/order\s*(?:#|no\.?|number|id)\s*:?\s*#?\s*([A-Za-z0-9-]{4,64})/i]
};

var RECEIPT_PLATFORM_UBEREATS = {
  id: 'ubereats',
  displayName: 'Uber Eats',
  enabled: true,
  support_status: 'unverified',
  category: '餐饮',
  gmailQuery: ['from:(uber.com)'],
  merchantAliases: ['ubereats', 'uber eats'],
  matchSender: function (from) { return senderDomainIn(from, UBEREATS_RULES_.domains); },
  matchMessage: function (from, subject) {
    return senderDomainIn(from, UBEREATS_RULES_.domains) &&
      (textHas(subject, UBEREATS_RULES_.eatsHeader) || textHas(from && from.name, UBEREATS_RULES_.eatsHeader));
  },
  /** from = {name, domain}（parseFromHeader）。正文 text 只用来判断“有没有金额”，不用来判断是不是 Uber Eats。 */
  classify: function (subject, text, from) {
    var R = UBEREATS_RULES_;
    var labels = R.totalLabels.concat(R.refundLabels);
    var noise = textHas(subject, R.never) || textHas(subject, R.promo) || textHas(subject, RECEIPT_PROMO_TEXT_);
    var eats = textHas(subject, R.eatsHeader) || textHas(from && from.name, R.eatsHeader);
    if (!eats) {
      if (textHas(subject, R.never)) return 'other';             // Uber One、Uber Cash 等
      if (textHas(subject, R.ride)) return 'other';              // 打车收据（D14：不记账）
      return hasLabeledMoney(text, labels) ? 'uncertain' : 'other';
    }
    // 收据/退款主题同时带促销或会员字样（例如“Your Uber Eats order with Hot Deals Pizza”）→ uncertain，列入待查看
    if (textHas(subject, R.refund)) return noise ? 'uncertain' : 'refund';
    if (textHas(subject, R.ride)) return 'uncertain';           // 邮件头同时像外卖又像行程：交给你看
    var explicit = textHas(subject, R.receipt) || textHas(subject, RECEIPT_PAID_SUBJECT_);
    if (explicit && noise) return 'uncertain';
    if (noise) return 'other';
    return receiptEvidenceKind_(subject, text, explicit, labels);
  },
  extractTotal: function (text) { return extractLabeledAmount(text, UBEREATS_RULES_.totalLabels, UBEREATS_RULES_.excludeLabels, { finalTotal: true }); },
  extractRefund: function (text) { return extractLabeledAmount(text, UBEREATS_RULES_.refundLabels, UBEREATS_RULES_.excludeLabels); },
  extractOrderRef: function (text, links) { return findOrderRef(text, links, UBEREATS_RULES_.orderLinks, UBEREATS_RULES_.orderText); }
};
