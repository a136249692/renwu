// 回归测试：思维块 Ctrl/⌘ 多选 + 成组拖动
// 背景：downOnNode / onUp 已经按「文件选择器」语义维护多选集合 selectedNodeIds，
// 但节点正文的 click 处理器随后无条件调用 selectNode()，而 selectNode 会把
// selectedNodeIds 重建成单点集合——于是 Ctrl+点选累积的多选立刻被清掉，
// 表现为「按住 Ctrl 选不了多个思维块，也就无法成组拖动」。
//
// 本测试以「源码静态断言」形式锁定不变量，避免未来回归。
// 运行方式：node test/mind-multiselect.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIND = fs.readFileSync(path.join(ROOT, "src/mindmap.js"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

test("节点正文 click 处理器在 Ctrl/⌘ 按下时提前返回（不重置多选集合）", () => {
  const start = MIND.indexOf('body.addEventListener("click", e => {');
  assert.ok(start >= 0, "mindmap.js 应存在节点正文的 click 处理器");
  const end = MIND.indexOf("\n  });", start);
  const block = MIND.substring(start, end === -1 ? MIND.length : end);
  assert.ok(/if\s*\(\s*e\.ctrlKey\s*\|\|\s*e\.metaKey\s*\)\s*return;/.test(block),
    "click 处理器必须先判断 Ctrl/⌘ 并 return，否则 selectNode() 会把累积的多选重置为单点");
  assert.ok(/selectNode\(n\.id\)/.test(block),
    "非 Ctrl 单击仍应走 selectNode(n.id) 收起为单点选中");
});

test("downOnNode 以 selectedNodeIds 快照作为本次拖动的集合", () => {
  const start = MIND.indexOf("function downOnNode(");
  assert.ok(start >= 0, "mindmap.js 必须定义 downOnNode");
  const end = MIND.indexOf("\nfunction placeNodeOnTop(", start);
  const body = MIND.substring(start, end === -1 ? MIND.length : end);
  assert.ok(/const\s+dragIds\s*=\s*new\s+Set\(\s*selectedNodeIds\s*\)/.test(body),
    "应以 selectedNodeIds 的快照作为拖动集合，避免边拖边读造成累积误差");
  assert.ok(/for\s*\(const id of drag\.ids\)/.test(body),
    "拖动过程中应遍历 drag.ids 整组一起位移");
});

test("onUp 成组落库：遍历 drag.ids 逐个持久化坐标", () => {
  const start = MIND.indexOf("function downOnNode(");
  const end = MIND.indexOf("\nfunction placeNodeOnTop(", start);
  const body = MIND.substring(start, end === -1 ? MIND.length : end);
  assert.ok(/for\s*\(const id of movedIds\)/.test(body) && /apiUpdateNodePos/.test(body),
    "松手后应遍历 movedIds 逐个调用 apiUpdateNodePos 落库");
});

test("Ctrl/⌘ 点击的选中态切换发生在 pointerup（无拖动时才切换）", () => {
  const start = MIND.indexOf("function downOnNode(");
  const end = MIND.indexOf("\nfunction placeNodeOnTop(", start);
  const body = MIND.substring(start, end === -1 ? MIND.length : end);
  assert.ok(/else if \(isCtrl\)/.test(body),
    "pointerup 里应有 isCtrl 分支处理「无拖动」的选中态切换");
  assert.ok(/wasSelectedBefore\s*\?\s*selectedNodeIds\.delete/.test(body) ||
            /if\s*\(wasSelectedBefore\)\s*selectedNodeIds\.delete\(n\.id\)/.test(body),
    "按下前已选中的节点，再次 Ctrl+点应取消选中（toggle）");
});

test("锚点节点被移出集合时，selectedNodeId 改指向剩余节点（避免工具栏指向已取消项）", () => {
  const start = MIND.indexOf("function downOnNode(");
  const end = MIND.indexOf("\nfunction placeNodeOnTop(", start);
  const body = MIND.substring(start, end === -1 ? MIND.length : end);
  assert.ok(/selectedNodeId === n\.id && !selectedNodeIds\.has\(n\.id\)/.test(body),
    "应在移除后修正 selectedNodeId 锚点");
});

// 汇总
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);