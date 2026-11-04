/**
 * 站点黑名单：命中后整页翻译直接被拒绝。
 *
 * 为什么需要：企业后台、银行、代码托管、登录页这类站点，
 * 机器翻译可能破坏表单语义或把敏感内容送出设备。
 *
 * 匹配语法：
 *   example.com        精确匹配该主机名（含其子域）
 *   *.example.com      仅匹配子域
 *   /path/prefix       按路径前缀匹配
 *   空行与空项会被忽略
 */

/**
 * 把设置里的黑名单字符串解析成条目数组。
 * @param {string} raw 原始文本（逗号或换行分隔）
 * @return {string[]} 清洗后的条目
 */
function parseBlacklist(raw) {
  return String(raw || "")
    .split(/[\n,]/)
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 判断当前 URL 是否命中黑名单。
 * @param {string} href 页面地址
 * @param {string} raw 黑名单文本
 * @return {boolean} 是否命中
 */
function isBlocked(href, raw) {
  const entries = parseBlacklist(raw);
  if (entries.length === 0) return false;

  let url;
  try {
    url = new URL(href);
  } catch {
    return false;
  }

  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();

  return entries.some(entry => {
    // 路径前缀：以 / 开头
    if (entry.startsWith("/")) return path.startsWith(entry);

    // 子域通配：*.example.com
    if (entry.startsWith("*.")) {
      const base = entry.slice(2);
      return host.endsWith(`.${base}`);
    }

    // 主机名：精确或含子域（example.com 同时覆盖 a.example.com）
    return host === entry || host.endsWith(`.${entry}`);
  });
}

const api = { parseBlacklist, isBlocked };

// content script 是传统脚本（禁止 ESM），通过 window.__TP_BLACKLIST__ 暴露。
// Node 单测环境没有 window，用 try 兜住，先保证 module.exports 生效。
try {
  if (typeof window !== "undefined") window.__TP_BLACKLIST__ = api;
} catch {
  // 忽略
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
