/**
 * 时间工具：账本按“费城时间”（America/New_York）决定每笔账属于哪一天、哪个月。
 * 数据里保存的是 UTC 时间（ISO 字符串），显示和归月时再换算成费城时间。
 * 这样手机在别的时区时，也不会改变账目的月份（PRD 第 7 节“月份归属”）。
 */

var LEDGER_TZ = 'America/New_York';

/** 把一个时间点换算成费城当地的年月日时分。返回 {y, mo, d, h, mi}（都是数字）。 */
function nyParts(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) throw new Error('无效的时间：' + date);
  var fmt = nyFormatter_();
  if (fmt) {
    var out = {};
    fmt.formatToParts(d).forEach(function (p) { out[p.type] = p.value; });
    return { y: +out.year, mo: +out.month, d: +out.day, h: +out.hour % 24, mi: +out.minute };
  }
  // 后备方案：Apps Script 的 Utilities.formatDate（同样使用 IANA 时区数据）
  var s = Utilities.formatDate(d, LEDGER_TZ, 'yyyy-MM-dd-HH-mm').split('-');
  return { y: +s[0], mo: +s[1], d: +s[2], h: +s[3], mi: +s[4] };
}

var nyFormatterCache_ = undefined;
/** Intl 的时区格式化器；当前运行环境不支持时返回 null，改用 Utilities.formatDate。 */
function nyFormatter_() {
  if (nyFormatterCache_ !== undefined) return nyFormatterCache_;
  try {
    var f = new Intl.DateTimeFormat('en-US', {
      timeZone: LEDGER_TZ, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    // 自检：2026-02-01T04:30Z 在费城应是 1 月 31 日 23:30
    var chk = {};
    f.formatToParts(new Date(Date.UTC(2026, 1, 1, 4, 30))).forEach(function (p) { chk[p.type] = p.value; });
    nyFormatterCache_ = (chk.month === '01' && chk.day === '31' && +chk.hour === 23) ? f : null;
  } catch (e) {
    nyFormatterCache_ = null;
  }
  return nyFormatterCache_;
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** 费城月份 'YYYY-MM' */
function monthNY(date) {
  var p = nyParts(date);
  return p.y + '-' + pad2_(p.mo);
}

/** 费城日期 'YYYY-MM-DD' */
function dateNY(date) {
  var p = nyParts(date);
  return p.y + '-' + pad2_(p.mo) + '-' + pad2_(p.d);
}

/** 费城当地时间 'YYYY-MM-DDTHH:mm'（给“记一笔”页面的日期时间输入框用） */
function localNY(date) {
  var p = nyParts(date);
  return p.y + '-' + pad2_(p.mo) + '-' + pad2_(p.d) + 'T' + pad2_(p.h) + ':' + pad2_(p.mi);
}

/**
 * 把费城当地时间 'YYYY-MM-DDTHH:mm' 换算成 UTC 的 Date。
 * - 夏令时回拨（同一钟点出现两次）：取较早的那一刻（spec 4.6）。
 * - 夏令时拨快（钟点不存在，例如 3 月某日 02:30）：按标准时间理解，结果是 03:30（夏令时）。
 * 费城只有两种偏移：夏令时 UTC-4、标准时间 UTC-5。
 */
function parseLocalNY(local) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(local || ''));
  if (!m) throw new Error('日期时间格式应为 YYYY-MM-DDTHH:mm');
  var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5];
  var asUtc = Date.UTC(y, mo - 1, d, h, mi);
  var check = new Date(asUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new Error('不存在的日期：' + local);
  }
  var HOUR = 3600000;
  var candidates = [asUtc + 4 * HOUR, asUtc + 5 * HOUR]; // 先试夏令时（较早的时刻）
  for (var i = 0; i < candidates.length; i++) {
    var p = nyParts(new Date(candidates[i]));
    if (p.y === y && p.mo === mo && p.d === d && p.h === h && p.mi === mi) return new Date(candidates[i]);
  }
  return new Date(asUtc + 5 * HOUR);
}

/** 'YYYY-MM' 的前一个月 / 后一个月 */
function addMonths(month, delta) {
  var y = +month.slice(0, 4), mo = +month.slice(5, 7) - 1 + delta;
  y += Math.floor(mo / 12);
  mo = ((mo % 12) + 12) % 12;
  return y + '-' + pad2_(mo + 1);
}

function isMonthString(s) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s));
}
