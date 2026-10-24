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
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
const CSS = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");

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

// ---------- 思维分组（打包成一组，整组选中 / 拖动） ----------

const fnBody = name => {
  const i = MIND.indexOf(`function ${name}`);
  if (i < 0) return "";
  const body = MIND.slice(i);
  return body.slice(0, body.indexOf("\n}\n") + 3);
};

test("工具栏提供「📦 分组 / ✂️ 解散分组」按钮", () => {
  assert.ok(/id="mind-group"/.test(HTML), "缺少 #mind-group 按钮");
  assert.ok(/id="mind-ungroup"/.test(HTML), "缺少 #mind-ungroup 按钮");
  assert.ok(/mindGroupBtn\.addEventListener\("click"/.test(MIND), "分组按钮应绑定 createMindGroup");
  assert.ok(/mindUngroupBtn\.addEventListener\("click"/.test(MIND), "解散按钮应绑定 ungroupMindSelection");
});

test("分组按钮只在多选 ≥2 个时出现，解散只在选中集合含分组块时出现", () => {
  const b = fnBody("syncMindToolbarBtns");
  assert.ok(/selectedNodeIds\.size\s*>=\s*2/.test(b), "分组按钮应按多选数量显隐");
  assert.ok(/groupOfNode\(id\)/.test(b), "解散按钮应检查选中集合是否属于分组");
});

test("分组数据按导图持久化到 localStorage", () => {
  assert.ok(/LS_MIND_GROUPS\s*=\s*"glassCanvas\.mindGroups"/.test(MIND), "应定义分组存储 key");
  assert.ok(/localStorage\.setItem\(LS_MIND_GROUPS/.test(fnBody("persistMindGroups")), "应落盘");
  assert.ok(/mindGroups\[activeMapId\]\s*=\s*gs/.test(MIND), "分组应按 activeMapId 分开保存");
});

test("createMindGroup 要求 ≥2 个且把成员从旧分组移出", () => {
  const b = fnBody("createMindGroup");
  assert.ok(/ids\.length\s*<\s*2/.test(b), "少于 2 个应拒绝分组");
  assert.ok(/gs\[gid\]\.filter\(id => !ids\.includes\(id\)\)/.test(b), "应把成员从旧分组中剔除");
  assert.ok(/persistMindGroups\(\)/.test(b), "分组后应落盘");
});

test("点分组内任意一块 → 选中整组（selectNode 与 downOnNode 都走 selectionWithGroup）", () => {
  const sel = fnBody("selectNode");
  assert.ok(/selectionWithGroup\(id\)/.test(sel), "selectNode 应扩展为整组");
  const down = MIND.slice(MIND.indexOf("function downOnNode("), MIND.indexOf("\nfunction placeNodeOnTop("));
  assert.ok(/selectionWithGroup\(n\.id\)/.test(down), "downOnNode 应按分组扩展拖动集合");
});

test("分组不在画布上画任何框/底色（避免干扰阅读），只保留失效清理", () => {
  const prune = fnBody("pruneMindGroups");
  assert.ok(/live\.length\s*<\s*2/.test(prune), "成员不足 2 个时清理失效分组");
  assert.ok(/mindGroups\[activeMapId\] = gs/.test(prune) && /persistMindGroups\(\)/.test(prune),
    "剪掉失效成员后应落盘");
  assert.ok(/pruneMindGroups\(\)/.test(fnBody("renderMindCanvas")), "渲染节点后应清理失效分组");
  assert.ok(!/mind-group-box/.test(MIND), "不应再渲染分组虚线框");
  assert.ok(!/renderMindGroupBoxes/.test(MIND), "不应保留分组框渲染函数");
  const down = MIND.slice(MIND.indexOf("function downOnNode("), MIND.indexOf("\nfunction placeNodeOnTop("));
  assert.ok(!/mind-group/.test(down), "拖动时不应再做分组框重排");
});

test("CSS 不再有分组虚线框/底色样式", () => {
  assert.ok(!/\.mind-group-box\s*\{/.test(CSS), "应删除 .mind-group-box 虚线样式");
  assert.ok(!/\.mind-groups\s*\{/.test(CSS), "应删除分组图层样式");
});

// 汇总
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);