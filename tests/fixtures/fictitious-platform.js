/**
 * 测试专用：一个虚构的第四个外卖平台“Pizza Planet”（spec 10 切片 2：证明加平台只需写规则文件 + 样本，共用流程不改）。
 * 写法与 apps/main/core/platforms/*.js 完全相同（Apps Script 风格，没有 module.exports），测试把它载入同一个全局作用域。
 * 它还提供 extractOrderTime + bodyTimeZone，用来测试 D2：可靠的下单时间才用于归月。
 */
var PIZZAPLANET_RULES_ = {
  domains: ['pizzaplanet.example'],
  totalLabels: ['Amount Paid'],
  excludeLabels: ['Pizza Subtotal'],
  refundLabels: ['Money Back'],
  subject: { never: [], refund: /money back/i, promo: /coupon/i, receipt: /your pizza receipt/i },
  orderText: [/pizza order\s*([A-Z0-9-]{4,64})/i]
};

var RECEIPT_PLATFORM_PIZZAPLANET = {
  id: 'pizzaplanet',
  displayName: 'Pizza Planet',
  enabled: true,
  support_status: 'unverified',
  category: '餐饮',
  gmailQuery: ['from:(pizzaplanet.example)'],
  merchantAliases: ['pizzaplanet'],
  bodyTimeZone: 'UTC',
  matchSender: function (from) { return senderDomainIn(from, PIZZAPLANET_RULES_.domains); },
  classify: function (subject, text) {
    return classifyBySubject(subject, text, Object.assign({ amountLabels: PIZZAPLANET_RULES_.totalLabels }, PIZZAPLANET_RULES_.subject));
  },
  extractTotal: function (text) { return extractLabeledAmount(text, PIZZAPLANET_RULES_.totalLabels, PIZZAPLANET_RULES_.excludeLabels); },
  extractRefund: function (text) { return extractLabeledAmount(text, PIZZAPLANET_RULES_.refundLabels, []); },
  extractOrderRef: function (text) { return findOrderRef(text, [], [], PIZZAPLANET_RULES_.orderText); },
  /** 正文“Ordered at: 2026-01-31T23:58Z”（UTC）→ Date；没有就返回 null。 */
  extractOrderTime: function (text) {
    var m = /ordered at:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})z/i.exec(text);
    return m ? new Date(m[1] + ':00Z') : null;
  }
};
