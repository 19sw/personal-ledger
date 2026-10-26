/** Uber rides rule. Uber Eats has a separate rule; dispatch uses only the From and Subject headers. */
var UBER_RULES_ = {
  domains: ['uber.com'],
  eatsHeader: /uber\s*eats/i,
  never: /uber\s*one|uber\s*cash|gift\s*card|membership|会员/i,
  promo: /\d+\s*%\s*off|% off|\bdeals?\b|\bpromo|\boffers?\b|优惠|折扣/i,
  ride: /\btrips?\b|\brid(e|es|ing)\b|行程|乘车|打车/i,
  receipt: /receipt|收据|invoice|账单|付款/i,
  refund: /refund|refunded|退款/i,
  totalLabels: ['Trip Total', 'Total Charged', 'Fare Total', 'Amount Paid', 'Total', '总计'].concat(['Grand Total', 'Amount Paid', '总计', '实付']),
  excludeLabels: ['Subtotal', 'Sub-total', 'Sub total'].concat(['小计', '优惠', '折扣', 'Total Savings']),
  refundLabels: ['Refund Total', 'Total Refund', 'Refund Amount', 'Refunded', 'Refund']
};

var RECEIPT_PLATFORM_UBER = {
  id: 'uber',
  displayName: 'Uber',
  enabled: true,
  support_status: 'unverified',
  category: '交通',
  gmailQuery: ['from:(uber.com)'],
  merchantAliases: ['uber'],
  matchSender: function (from) { return senderDomainIn(from, UBER_RULES_.domains); },
  // Both brands share uber.com. Route on mail headers, never on body/footer text.
  matchMessage: function (from, subject) {
    return senderDomainIn(from, UBER_RULES_.domains) &&
      !textHas(subject, UBER_RULES_.eatsHeader) && !textHas(from && from.name, UBER_RULES_.eatsHeader);
  },
  classify: function (subject, text, from) {
    var R = UBER_RULES_;
    if (textHas(subject, R.never)) return 'other';
    if (textHas(subject, R.promo) || textHas(subject, RECEIPT_PROMO_TEXT_)) return textHas(subject, R.receipt) || textHas(subject, R.refund) ? 'uncertain' : 'other';
    if (textHas(subject, R.refund)) return 'refund';
    var explicit = textHas(subject, R.receipt) || /(?:your|您(?:的)?).*(?:trip|ride|行程|乘车|打车)/i.test(subject);
    return receiptEvidenceKind_(subject, text, explicit, R.totalLabels);
  },
  extractTotal: function (text) { return extractLabeledAmount(text, UBER_RULES_.totalLabels, UBER_RULES_.excludeLabels, { finalTotal: true }); },
  extractRefund: function (text) { return extractLabeledAmount(text, UBER_RULES_.refundLabels, UBER_RULES_.excludeLabels); },
  extractOrderRef: function () { return null; }
};
