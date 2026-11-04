/**
 * 文本切分：按句边界把长文本拆成不超过 maxChars 的片段。
 * 导出供单元测试。
 */

/**
 * 按句边界把长文本拆成不超过 maxChars 的片段（句子尽量完整，超长单句硬切）。
 * @param {string} text 原文
 * @param {number} maxChars 单片字符上限
 * @return {string[]} 片段数组（拼接顺序与原文一致）
 */
export function splitSentences(text, maxChars) {
  if (!text || text.length <= maxChars) return text ? [text] : [];
  // 中英文句末标点后跟空白或直接结束都视为句边界
  const sentences = text.split(/(?<=[.!?。！？；;])\s*/);
  const segments = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // 单句超限：硬切成固定长度的片
      if (current) {
        segments.push(current);
        current = "";
      }
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        segments.push(sentence.slice(offset, offset + maxChars));
      }
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars) {
      segments.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) segments.push(current);
  return segments;
}
