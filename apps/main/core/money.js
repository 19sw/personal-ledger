/**
 * 金额工具：所有金额一律用“整数美分”保存和计算（12.34 美元 = 1234），避免小数误差。
 * 这里的函数在 Apps Script 和 Node 测试里都能运行（不依赖任何 Google 服务）。
 */

/**
 * 把用户输入或文本中的美元金额转成整数美分。
 * 接受：'12.34'、'$12.34'、'US$1,234.5'、'1,234.56 USD'、' 12 '。
 * 识别不了（空、乱码、超过两位小数、其他币种符号）时返回 null，交给调用方决定怎么处理。
 * 负号不在这里处理：退款由调用方根据“这是退款”转成负数。
 */
function parseUsdToCents(text) {
  if (text === null || text === undefined) return null;
  var s = String(text).normalize('NFKC').trim();
  if (s === '') return null;
  s = s.replace(/^(US\$|USD\s*|\$)\s*/i, '').replace(/\s*USD$/i, '').trim();
  // 千位分隔符必须是规范的三位一组，避免把 '1,2' 之类误读
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
  s = s.replace(/,/g, '');
  var parts = s.split('.');
  var whole = parts[0];
  var frac = (parts[1] || '').padEnd(2, '0');
  if (whole.length > 9) return null; // 超过 10 亿美元，视为输入错误
  return Number(whole) * 100 + Number(frac);
}

/** 把整数美分格式化成 '1,234.56'（负数为 '-1,234.56'）。null 返回 '—'。 */
function formatCents(cents) {
  if (cents === null || cents === undefined) return '—';
  var neg = cents < 0;
  var abs = Math.abs(cents);
  var whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  var frac = String(abs % 100).padStart(2, '0');
  return (neg ? '-' : '') + whole + '.' + frac;
}

/**
 * 占比，单位是“0.1 个百分点”（返回 600 表示 60.0%），四舍五入（0.5 进位）。
 * 全程整数运算：round(part * 1000 / total)。total <= 0 或 part < 0 时返回 null（不显示百分比）。
 */
function percentTenths(part, total) {
  if (!(total > 0) || part < 0) return null;
  return Math.floor((2 * part * 1000 + total) / (2 * total));
}

/** 600 → '60.0%'；null → '' */
function formatPercentTenths(tenths) {
  if (tenths === null || tenths === undefined) return '';
  return Math.floor(tenths / 10) + '.' + (tenths % 10) + '%';
}
