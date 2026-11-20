// 回归测试：任务视图「内容块重叠 / 滚动定位漂移」六类根因修复
// 背景（详见 /workspace/任务视图-重叠与滚动漂移-全面测试报告.md）：
//   R1 encodePos 不清 right → 块被拉宽、避让宽度失真
//   R2 renderAll→restoreScroll 用旧记忆覆盖当前滚动（200ms debounce 窗口）
//   R3 切 tab 时 pane display:none 把 scrollTop 归零，且未强制保存
//   R4 编辑后块变高不重排 → 压住邻居
//   R5 新建/粘贴落点不避让 + 固定 62px 步进
//   R6 加载更多按 44px/行估算，且插入段顶不补偿 scrollTop
//
// 本测试以「源码静态断言」锁定不变量，避免未来回归。
// 运行方式：node test/overlap-drift-fixes.test.mjs

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
function bodyOf(fnName, nextMarker) {
  const start = MAIN.indexOf(`function ${fnName}(`);
  assert.ok(start >= 0, `main.js 必须定义 ${fnName}`);
  const end = nextMarker ? MAIN.indexOf(nextMarker, start + 1) : -1;
  return MAIN.substring(start, end === -1 ? MAIN.length : end);
}

// ── R1 ──
test("R1 encodePos：自由块分支清空 right，堆叠行分支仍写 right:20px", () => {
  const body = bodyOf("encodePos", "\n}\n");
  assert.ok(/el\.style\.left\s*=\s*b\.x\s*\+\s*"px"/.test(body), "自由块应写 left");
  assert.ok(/el\.style\.right\s*=\s*""/.test(body),
    "自由块必须清空 row 期遗留的 right，否则 left+right 同时存在会被拉宽");
  assert.ok(/el\.style\.right\s*=\s*"20px"/.test(body), "row 分支应继续写 right:20px");
});

// ── R2 ──
test("R2 restoreScroll：dirty 时先强制落库并跳过恢复", () => {
  const body = bodyOf("restoreScroll", "function saveScroll(");
  assert.ok(/_scrollDirty/.test(body), "restoreScroll 必须检查 _scrollDirty");
  assert.ok(/if\s*\(_scrollDirty\)\s*\{[\s\S]{0,60}?saveScroll\(true\);[\s\S]{0,20}?return;/.test(body),
    "dirty 分支应先 saveScroll(true) 再 return");
  assert.ok(/let _scrollDirty\s*=\s*false/.test(MAIN), "必须有 _scrollDirty 状态位");
});

test("R2 saveScroll：写库成功后清除 dirty", () => {
  const start = MAIN.indexOf("function saveScroll(");
  const end = MAIN.indexOf("canvas.addEventListener(\"scroll\"", start);
  const body = MAIN.substring(start, end);
  assert.ok(/_scrollDirty\s*=\s*false/.test(body), "saveScroll 落库后应清除 dirty");
});

test("R2 saveScroll：pane 隐藏时丢弃假 scrollTop（含迟到的 debounce / 关窗保存）", () => {
  const start = MAIN.indexOf("function saveScroll(");
  const end = MAIN.indexOf("canvas.addEventListener(\"scroll\"", start);
  const body = MAIN.substring(start, end);
  assert.ok(/taskPane\s*&&\s*\(taskPane\.hidden \|\| !canvas\.clientHeight\)/.test(body),
    "隐藏 / 无高度时不能把 0 写入记忆");
  assert.ok(/if \(force\) clearTimeout\(canvas\._t\)/.test(body),
    "强制保存时应取消待触发的 debounce，避免随后用隐藏态的 0 覆盖");
});

test("R2 renderAll 默认不恢复滚动；冷启动 / 切夹 / 切回 tab 才显式传 true", () => {
  assert.ok(/function renderAll\(restore = false\)/.test(MAIN), "renderAll 应带 restore 参数且默认 false");
  const guards = MAIN.match(/if \(restore\) restoreScroll\(\);/g) || [];
  assert.equal(guards.length, 2, "普通区与便利贴区各一处受 restore 控制");
  assert.ok(/await reloadTasks\(\); renderAll\(true\); \}/.test(MAIN), "冷启动回灌后应 renderAll(true)");
  assert.ok(/await reloadTasks\(\);\s*renderAll\(true\);/.test(MAIN), "切夹后应 renderAll(true)");
  assert.ok(/window\.renderAll = renderAll;/.test(MAIN), "仍应暴露 renderAll 给其它模块");
  assert.ok(/window\.renderAll\(true\)/.test(MIND), "mindmap 切回任务 tab 应 renderAll(true)");
  assert.ok(/alignToggle\.checked = alignMode;\s*(?:\/\/[^\n]*\n\s*)*renderAll\(true\);/.test(MAIN),
    "冷启动 boot() 首次渲染应 renderAll(true) 恢复上次滚动位置");
});

test("R2 scroll 监听：pane 隐藏 / 无高度时不算用户滚动，不标 dirty", () => {
  const start = MAIN.indexOf('canvas.addEventListener("scroll"');
  assert.ok(start >= 0);
  const body = MAIN.substring(start, MAIN.indexOf('window.addEventListener("resize"', start));
  assert.ok(/taskPane\s*&&\s*taskPane\.hidden/.test(body), "隐藏态应直接 return");
  assert.ok(/_scrollDirty\s*=\s*true/.test(body), "真实滚动才标 dirty");
});

// ── R3 ──
test("R3 main.js 暴露 __saveTaskScroll，mindmap 切走前强制保存", () => {
  assert.ok(/window\.__saveTaskScroll\s*=\s*saveScroll\s*;/.test(MAIN),
    "main.js 应暴露 window.__saveTaskScroll = saveScroll");
  const start = MIND.indexOf("function setMode(");
  const body = MIND.substring(start, MIND.indexOf("/* ═", start));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const saveAt = code.indexOf("window.__saveTaskScroll(true)");
  const hideAt = code.indexOf('folderPane.hidden = m !== "tasks"');
  assert.ok(saveAt >= 0, "setMode 离开 tasks 时应调用 window.__saveTaskScroll(true)");
  assert.ok(hideAt > saveAt, "保存必须发生在 folderPane.hidden 之前");
});

// ── R4 ──
test("R4 settleAfterEdit：堆叠区重排、自由区检测压叠后重新避让", () => {
  const body = bodyOf("settleAfterEdit", "/* ---------- 编辑态 ---------- */");
  assert.ok(/b\.stage !== "todo"/.test(body) && /relayout\(false\)/.test(body), "堆叠区应重排");
  assert.ok(/alignPendingBlocks\(\[\]\)/.test(body), "对齐模式应重新堆栈");
  assert.ok(/rectsOverlap\(/.test(body), "自由区应检测是否压住邻居");
  assert.ok(/findFreeSpot\(b, reviewY\(\), false\)/.test(body), "压叠后应按当前落点重新避让");
});

test("R4 blur 提交后延迟两帧再收尾排版（等 autoSize 宽度生效）", () => {
  const idx = MAIN.indexOf("autoSize(el, b, title);\n    /* autoSize 在下一帧才写入 minWidth");
  assert.ok(idx >= 0, "blur 中 autoSize 后应接 settle 调度");
  const tail = MAIN.substring(idx, idx + 320);
  assert.ok(/requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => settleAfterEdit\(el, b\)\)\)/.test(tail),
    "应使用双 rAF 等布局稳定后再 settleAfterEdit");
});

// ── R5 ──
test("R5 双击新建：落点被占用时用 findFreeSpot 避让", () => {
  const start = MAIN.indexOf('canvas.addEventListener("dblclick"');
  const body = MAIN.substring(start, MAIN.indexOf('/* ---------- Ctrl+V', start));
  assert.ok(/findFreeSpot\(nb, reviewY\(\), false\)/.test(body),
    "双击创建后应调用 findFreeSpot 避让");
});

test("R5 粘贴：移除固定 62px 步进，按实测块高逐个排布", () => {
  assert.ok(!/GAP\s*=\s*62/.test(MAIN), "不应再用固定 62px 估算块高");
  const body = bodyOf("placePastedBlocks", "async function createTasksFromPaste(");
  assert.ok(/findFreeSpot\(b, reviewY\(\), false\)/.test(body), "每个粘贴块都应避让");
  assert.ok(/el\.offsetHeight/.test(body), "步进应使用实测块高");
  assert.ok(/cursor\s*=\s*b\.y\s*\+\s*\(el \? el\.offsetHeight : 48\)\s*\+\s*12/.test(body),
    "下一块起点 = 上一块实际底部 + 12");
});

// ── R6 ──
test("R6 loadMoreDone 返回实测插入高度（分界线下移量）", () => {
  const body = bodyOf("loadMoreDone", "/* 「加载更多」胶囊点击");
  assert.ok(/dividerY\(\)/.test(body), "应以分界线下移量度量插入高度");
  assert.ok(/return Math\.max\(0, dividerY\(\) - y0\)/.test(body), "返回值应为实际插入高度");
});

test("R6 加载更多不再按 44px/行估算", () => {
  assert.ok(!/added \* 44/.test(MAIN), "不应再出现「条数 × 44px」估算");
  const start = MAIN.indexOf('document.getElementById("load-more-done")');
  const body = MAIN.substring(start, MAIN.indexOf("function defaultDoneY(", start));
  assert.ok(/const delta = loadMoreDone\(\)/.test(body), "胶囊点击应使用实测 delta");
  assert.ok(/canvas\.scrollTop - delta \+ 14/.test(body), "补偿量应为实测 delta");
});

test("R6 顶部自动加载：把视口按插入高度同步下移，锚定原内容", () => {
  const start = MAIN.indexOf('canvas.addEventListener("scroll"');
  const body = MAIN.substring(start, MAIN.indexOf('window.addEventListener("resize"', start));
  assert.ok(/const delta = loadMoreDone\(\)/.test(body), "自动加载应取实测 delta");
  assert.ok(/if \(delta > 0\) canvas\.scrollTop \+= delta/.test(body),
    "自动加载后应 scrollTop += delta，避免跳到最老记录");
});

// ── R7（S15）──
test("R7 normalizeTodoLayout：隐藏态 / 对齐模式 / 放大态 / 便签夹跳过", () => {
  const body = bodyOf("normalizeTodoLayout", "/* 就地重排：");
  assert.ok(/!canvas\.clientHeight \|\| !board\.clientWidth/.test(body), "画布不可见时不能按 0 宽度重排");
  assert.ok(/if \(alignMode \|\| isStickyFolderActive\(\)\) return;/.test(body), "对齐模式与便签夹不参与自由区校正");
  assert.ok(/board\.querySelector\("\.block\.zoomed"\)/.test(body), "放大编辑态位置无效，必须跳过");
});

test("R7 normalizeTodoLayout：越界块左移回画布并重新编码坐标", () => {
  const body = bodyOf("normalizeTodoLayout", "/* 就地重排：");
  assert.ok(/const maxRight = board\.clientWidth - 16/.test(body), "右边界应为画布宽 - 16");
  assert.ok(/b\.x \+ el\.offsetWidth > maxRight/.test(body), "应检测右边缘越界");
  assert.ok(/b\.x = Math\.max\(16, maxRight - el\.offsetWidth\)/.test(body), "越界块应左移回画布");
  assert.ok(/encodePos\(el, b\)/.test(body), "校正后必须把新坐标写回 DOM");
});

test("R7 normalizeTodoLayout：残余相交的块重新避让并落盘", () => {
  const body = bodyOf("normalizeTodoLayout", "/* 就地重排：");
  assert.ok(/rectsOverlap\(/.test(body), "应检测待完成块之间的残余重叠");
  assert.ok(/findFreeSpot\(b, bottomY, false\)/.test(body), "相交时应从当前位置重新找空位");
  assert.ok(/persistBlockPosition\(b\)/.test(body), "真正发生位移的块需要落盘");
});

test("R7 relayout 在统计画布高度前调用 normalizeTodoLayout", () => {
  const start = MAIN.indexOf("function relayout(");
  const body = MAIN.substring(start, MAIN.indexOf("function rectsOverlap(", start));
  const normAt = body.indexOf("normalizeTodoLayout(ry)");
  const heightAt = body.indexOf("board.style.height");
  assert.ok(normAt >= 0, "relayout 必须调用 normalizeTodoLayout(ry)");
  assert.ok(heightAt > normAt, "校正必须发生在 board 高度统计之前，否则滚动范围会算少");
});

// ── 汇总 ──
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
