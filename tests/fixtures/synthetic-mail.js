'use strict';
/**
 * 手写的合成收据样本（spec 6.3：不使用真实邮件，也不使用真实邮件打码后的版本）。
 * 商家名、地址、菜品、订单号都是编出来的。为了检查“日志和账本里没有邮件内容”，正文和主题里放了标记词：
 *   BODY_MARKER（正文）、SUBJECT_MARKER（主题）、以及假地址 FAKE_ADDRESS。
 * 每个函数返回“简化的邮件对象”{id, internalDate, from, subject, html, text}（与 simplifyGmailMessage 的输出相同）；
 * 需要 Gmail API 形状时用 tests/helpers/gmail.js 的 apiMessage 包一层。
 */

const BODY_MARKER = 'Zebracorn Noodle House';     // 合成的餐厅名（正文）
const SUBJECT_MARKER = 'Zebracorn';                // 主题里的商家名
const FAKE_ADDRESS = '742 Example Lane';           // 合成的送餐地址

function mail({ id, from, subject, html = '', text = '', at = '2026-10-15T16:00:00.000Z' }) {
  return { id, internalDate: new Date(at).getTime(), from, subject, html, text };
}

function rowsHtml(rows) {
  return '<table>' + rows.map(([k, v]) => `<tr><td style="padding:2px">${k}</td><td align="right">${v}</td></tr>`).join('') + '</table>';
}

function receiptHtml({ title, rows, extra = '', link = '' }) {
  return `<!DOCTYPE html><html><head><title>t</title><style>td{color:#333}</style></head><body>
<div>${title}</div><p>${BODY_MARKER}</p><p>Deliver to: ${FAKE_ADDRESS}</p>
${link ? `<a href="${link}">View order</a>` : ''}
${rowsHtml(rows)}
${extra}
<p>Questions? Visit our help center.</p></body></html>`;
}

// ---------------- DoorDash ----------------
const DD_FROM = 'DoorDash <no-reply@doordash.com>';

function ddReceipt({ id = 'dd0000000001', total = '$23.45', subtotal = '$18.00', orderId = 'a1b2c3d4-0001', at, tip = '$3.00', link = true } = {}) {
  return mail({
    id, at, from: DD_FROM, subject: `Order Confirmation for ${SUBJECT_MARKER} Noodle House`,
    html: receiptHtml({
      title: 'Thanks for your order!',
      link: link && orderId ? `https://www.doordash.com/orders/${orderId}/` : '',
      rows: [['2x Spicy Noodles', '$12.00'], ['Subtotal', subtotal], ['Delivery Fee', '$2.99'], ['Service Fee', '$1.50'],
        ['Estimated Tax', '$1.46'], ['Dasher Tip', tip], ['Promotion', '-$1.50'], ['Total', total]]
    })
  });
}

function ddReceiptNoRef(opts = {}) {
  return ddReceipt(Object.assign({ orderId: null, link: false }, opts));
}

function ddRefund({ id = 'dd0000000002', amount = '$5.00', orderId = 'a1b2c3d4-0001', at } = {}) {
  return mail({
    id, at, from: DD_FROM, subject: 'Your refund has been processed',
    html: receiptHtml({
      title: 'We\'ve issued a refund',
      link: orderId ? `https://www.doordash.com/orders/${orderId}/` : '',
      rows: [['Missing item', '1x Dumplings'], ['Refund Total', amount]]
    })
  });
}

function ddPromo({ id = 'dd0000000003', at } = {}) {
  return mail({
    id, at, from: 'DoorDash <deals@doordash.com>', subject: 'Get 40% off your next order',
    html: `<p>${BODY_MARKER} is now on DoorDash. Use code SAVE40.</p><p>Orders over $15. Valid through Sunday.</p>`
  });
}

// ---------------- Uber Eats / Uber ----------------
const UE_FROM = 'Uber Eats <uber@uber.com>';
const UBER_RIDES_FROM = 'Uber Receipts <noreply@uber.com>';

function ueReceipt({ id = 'ue0000000001', total = '$31.20', orderId = 'f00d0000-1111-2222', at } = {}) {
  return mail({
    id, at, from: UE_FROM, subject: `Your Uber Eats order with ${SUBJECT_MARKER} Tacos`,
    html: receiptHtml({
      title: 'Thanks for ordering, Sam',
      link: orderId ? `https://www.ubereats.com/orders/${orderId}` : '',
      rows: [['Subtotal', '$24.00'], ['Delivery Fee', '$0.49'], ['Taxes & Fees', '$3.71'], ['Tip', '$3.00'], ['Total', total]]
    })
  });
}

function ueRefund({ id = 'ue0000000002', amount = '$8.50', orderId = 'f00d0000-1111-2222', at } = {}) {
  return mail({
    id, at, from: UE_FROM, subject: 'Your Uber Eats refund',
    html: receiptHtml({ title: 'Refund issued', link: orderId ? `https://www.ubereats.com/orders/${orderId}` : '',
      rows: [['Refund Amount', amount]] })
  });
}

function uberRide({ id = 'ur0000000001', total = '$18.75', footer = false, at } = {}) {
  return mail({
    id, at, from: UBER_RIDES_FROM, subject: 'Your Tuesday evening trip with Uber',
    html: receiptHtml({
      title: 'Thanks for riding, Sam',
      rows: [['Trip fare', '$15.00'], ['Booking Fee', '$2.75'], ['Tip', '$1.00'], ['Total', total]],
      extra: footer ? '<div><p>Hungry? Try Uber Eats</p><p>Get $0 delivery fee on Uber Eats orders over $15</p><p>Order on Uber Eats</p></div>' : ''
    })
  });
}

// Entirely synthetic Chinese layout: no personal data or values copied from real receipts.
function uberChineseRide({ id = 'ur00000000c1', total = 'US$27.60', at, split = false } = {}) {
  return mail({ id, at, from: '优步收据 <receipts@uber.com>', subject: '您的周二行程收据',
    html: '<div>感谢搭乘优步</div><table><tr><td><div>总计</div></td><td>' +
      (split ? '<div>' + total + '</div>' : total) + '</td></tr>' +
      '<tr><td>行程车费</td><td>US$21.00</td></tr><tr><td>附加费</td><td>US$6.60</td></tr></table>' +
      '<p>试试 Uber Eats</p>' });
}

function uberOne({ id = 'ur0000000002', at } = {}) {
  return mail({ id, at, from: 'Uber One <uber@uber.com>', subject: 'Your Uber One membership receipt',
    html: receiptHtml({ title: 'Membership renewed', rows: [['Uber One monthly', '$9.99'], ['Total', '$9.99']] }) });
}

function uberCash({ id = 'ur0000000003', at } = {}) {
  return mail({ id, at, from: 'Uber <uber@uber.com>', subject: 'You added Uber Cash',
    html: receiptHtml({ title: 'Uber Cash added', rows: [['Amount', '$50.00'], ['Total', '$50.00']] }) });
}

function uberEatsPromo({ id = 'ue0000000003', at } = {}) {
  return mail({ id, at, from: UE_FROM, subject: 'Uber Eats: 50% off this weekend',
    html: `<p>${BODY_MARKER} 50% off. Order now on Uber Eats.</p>` });
}

function uberUnknownWithAmount({ id = 'ur0000000004', at } = {}) {
  return mail({ id, at, from: 'Uber <noreply@uber.com>', subject: 'Your receipt',
    html: receiptHtml({ title: 'Thanks', rows: [['Total', '$22.10']] }) });
}

function genericReceipt({ id = 'un0000000001', domain = 'shop.example', subject = 'Your receipt', total = '$7.25', at } = {}) {
  return mail({ id, at, from: 'Shop <receipts@' + domain + '>', subject: subject + ' ' + SUBJECT_MARKER,
    html: receiptHtml({ title: BODY_MARKER, rows: [['Subtotal', '$99.00'], ['Total', total]] }) });
}

module.exports = {
  BODY_MARKER, SUBJECT_MARKER, FAKE_ADDRESS, mail, receiptHtml,
  ddReceipt, ddReceiptNoRef, ddRefund, ddPromo,
  ueReceipt, ueRefund, uberRide, uberChineseRide, uberOne, uberCash, uberEatsPromo, uberUnknownWithAmount, genericReceipt
};
