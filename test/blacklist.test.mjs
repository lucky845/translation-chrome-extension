/**
 * 站点黑名单匹配测试。
 * 运行：node test/blacklist.test.mjs
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

// package.json 是 type=module，content 脚本不能直接 require；
// 用 Function 注入一个假的 module 容器来取导出，和 dom.test.mjs 的做法一致。
const source = readFileSync(new URL("../content/blacklist.js", import.meta.url), "utf8");
const sandbox = { module: { exports: {} } };
new Function("module", "window", source)(sandbox.module, undefined);
const { isBlocked, parseBlacklist } = sandbox.module.exports;

const results = [];

/**
 * 记录一个用例。
 * @param {string} name 名称
 * @param {Function} fn 用例
 */
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
  }
}

console.log("[1] 解析");

test("忽略空行、空项与首尾空格", () => {
  assert.deepEqual(parseBlacklist(" github.com \n\n, ,*.bank.com,"), ["github.com", "*.bank.com"]);
  assert.deepEqual(parseBlacklist(""), []);
});

console.log("\n[2] 匹配");

test("空黑名单不拦截任何站点", () => {
  assert.equal(isBlocked("https://github.com/a", ""), false);
});

test("精确域名命中，且覆盖其子域", () => {
  assert.equal(isBlocked("https://github.com/lucky845", "github.com"), true);
  assert.equal(isBlocked("https://gist.github.com/x", "github.com"), true);
});

test("带 www 的主机也能被裸域命中", () => {
  assert.equal(isBlocked("https://www.bank.com/pay", "bank.com"), true);
});

test("通配符 *.example.com 只匹配子域，不含主域本身", () => {
  assert.equal(isBlocked("https://a.bank.com/x", "*.bank.com"), true);
  assert.equal(isBlocked("https://bank.com/x", "*.bank.com"), false);
});

test("路径前缀匹配", () => {
  assert.equal(isBlocked("https://example.com/settings/profile", "/settings"), true);
  assert.equal(isBlocked("https://example.com/docs", "/settings"), false);
});

test("不相关站点不被误伤", () => {
  assert.equal(isBlocked("https://example.com", "github.com,bank.com"), false);
});

test("非法 URL 不抛错，按不拦截处理", () => {
  assert.equal(isBlocked("not-a-url", "github.com"), false);
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
