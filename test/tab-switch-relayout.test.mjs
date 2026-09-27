// 回归测试：切回任务 tab 时的重布局钩子
// 背景：v1.0.28 之前 mindmap.js 直接调用 `renderAll && renderAll()`，
// 但 renderAll 是 main.js 的模块私有函数，模块作用域下永远为 undefined，
// 导致 setMode("tasks") 分支的 double-rAF 回调里 renderAll 从未执行，
// 切回任务 tab 后 todo 区内容块堆积/重叠（无 relayout 重算分界线）。
//
// 本测试以「源码静态断言」形式锁定不变量，避免未来回归。
// 运行方式：node test/tab-switch-relayout.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const MAIN = fs.readFileSync(path.join(ROOT, "src/main.js"), "utf8");
const MIND = fs.readFileSync(path.join(ROOT, "src/mindmap.js"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

test("main.js 末尾将 renderAll 挂到 window（跨模块可访问）", () => {
  // 允许等号两边空格，但必须是 window.renderAll = renderAll; 而非 window.renderAll = 某匿名函数
  const re = /window\.renderAll\s*=\s*renderAll\s*;/;
  assert.ok(re.test(MAIN), "main.js 应包含 `window.renderAll = renderAll;`");
});

test("main.js 暴露 __alignPendingBlocks 供切 tab 后重对齐", () => {
  const re = /window\.__alignPendingBlocks\s*=\s*alignPendingBlocks\s*;/;
  assert.ok(re.test(MAIN), "main.js 应包含 `window.__alignPendingBlocks = alignPendingBlocks;`");
});

test("main.js 暴露 __getAlignToggle / __isStickyFolderActive 供 mindmap 判定对齐偏好", () => {
  assert.ok(/window\.__getAlignToggle\s*=\s*\(\)\s*=>\s*alignToggle/.test(MAIN));
  assert.ok(/window\.__isStickyFolderActive\s*=\s*\(\)\s*=>\s*isStickyFolderActive\(\)/.test(MAIN));
});

test("mindmap.js setMode('tasks') 分支通过 window.renderAll 触发重排（不再用裸 renderAll）", () => {
  // 提取 setMode 函数体
  const start = MIND.indexOf("function setMode(");
  assert.ok(start >= 0, "mindmap.js 必须定义 setMode 函数");
  const end = MIND.indexOf("/* ═", start + 1);
  const rawBody = MIND.substring(start, end === -1 ? MIND.length : end);
  // 保留注释中的原文（防止注释被剥掉后旧写法误漏），但断言只看代码部分。
  // 为区分「代码里调用」和「注释里描述旧写法」，先把所有注释替换为空字符串。
  const codeOnly = rawBody
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  assert.ok(/window\.renderAll/.test(codeOnly),
    "setMode 内必须显式调用 window.renderAll");
  assert.ok(!/renderAll\s*&&\s*renderAll\s*\(\)/.test(codeOnly),
    "setMode 代码中不应再出现 `renderAll && renderAll()` 旧写法");
  assert.ok(/requestAnimationFrame\s*\(\s*\(\)\s*=>\s*requestAnimationFrame/.test(codeOnly),
    "setMode 内应保留双 rAF，等待 canvas display:none 恢复后的 reflow");
  assert.ok(/window\.__alignPendingBlocks/.test(codeOnly),
    "切回 tasks 后应调用 window.__alignPendingBlocks 恢复「靠左对齐」偏好");
});

test("layoutStackedRows 在 pane 隐藏时提前返回（防御性 defer）", () => {
  // 提取 layoutStackedRows 函数体
  const start = MAIN.indexOf("function layoutStackedRows(");
  assert.ok(start >= 0);
  const end = MAIN.indexOf("function layoutDoneRows(", start);
  const body = MAIN.substring(start, end);
  assert.ok(/offsetHeight\s*===\s*0/.test(body) && /clientHeight\s*===\s*0/.test(body),
    "layoutStackedRows 应检测 offsetHeight===0 && clientHeight===0 并跳过");
  assert.ok(/deferred:\s*true/.test(body),
    "防御分支应返回 {deferred:true} 以便调用方识别");
});

test("alignPendingBlocks 在 pane 隐藏时提前 return（防御性 defer）", () => {
  const start = MAIN.indexOf("function alignPendingBlocks(");
  assert.ok(start >= 0);
  // 找到函数体结束（下一个顶层 /* 注释块前）
  const end = MAIN.indexOf("/* 把滚动条定位", start);
  const body = MAIN.substring(start, end === -1 ? MAIN.length : end);
  assert.ok(/offsetHeight\s*===\s*0/.test(body) && /clientHeight\s*===\s*0/.test(body),
    "alignPendingBlocks 应检测 offsetHeight===0 && clientHeight===0 并 return");
});

// 汇总
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
