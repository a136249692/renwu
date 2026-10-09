// 回归测试：图片夹跨夹复制/剪切（含描述文字）
// 用户诉求：A 夹选图片 → 复制/剪切 → 切到 B 夹粘贴，图片文件和描述文字一起搬过去。
// 关键实现点：
//   1) 剪贴板快照带 bytes + title，粘贴时 title 一并写入新 item
//   2) cut 模式只在粘贴成功后才删除源图（OS 剪贴板语义）
//   3) 按钮显隐 + Ctrl+C/X/V 快捷键
//   4) paste 事件在无外部图片时回退到内部剪贴板
// 运行方式：node test/image-clipboard.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const IMG = fs.readFileSync(path.join(ROOT, "src/image-wall.js"), "utf8");
const MIND = fs.readFileSync(path.join(ROOT, "src/mindmap.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}

// 剥掉块注释和行注释，避免注释里的关键字污染断言
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const IMG_CODE = stripComments(IMG);
const MIND_CODE = stripComments(MIND);

// ---------- HTML：三个按钮 + 分隔线 ----------
test("HTML 存在 image-copy / image-cut / image-paste 三个按钮", () => {
  assert.ok(/id="image-copy"/.test(HTML), "image-copy 按钮缺失");
  assert.ok(/id="image-cut"/.test(HTML),  "image-cut 按钮缺失");
  assert.ok(/id="image-paste"/.test(HTML),"image-paste 按钮缺失");
});

// ---------- 状态与 API ----------
test("定义模块级 _clipboard 变量", () => {
  assert.ok(/\blet _clipboard\s*=\s*null/.test(IMG_CODE));
});

test("snapshotSelection 保存 mode + takenFrom + takenAt + items", () => {
  // 允许单行或多行、任意空白、允许 shorthand（{ mode, items: snaps }）
  const re = /return\s*\{[\s\S]*?\bmode\b[\s\S]*?takenFrom\s*:\s*activeFolder\.id[\s\S]*?takenAt\s*:\s*Date\.now\(\)[\s\S]*?\bitems\s*:\s*snaps\b[\s\S]*?\}/;
  assert.ok(re.test(IMG_CODE), "snapshotSelection 应返回 {mode,takenFrom,takenAt,items}");
});

test("snapshot 里 items 元素包含 title 字段（描述文字随快照走）", () => {
  assert.ok(/title\s*:\s*it\.title\s*\|\|\s*""/.test(IMG_CODE),
    "snapshotSelection 必须把 title 保存到快照");
});

test("snapshot 里 items 元素包含 srcFolderId + srcItemId（切夹后仍能定位源图）", () => {
  assert.ok(/srcFolderId\s*:\s*it\.folder_id/.test(IMG_CODE));
  assert.ok(/srcItemId\s*:\s*it\.id/.test(IMG_CODE));
});

// ---------- 复制 / 剪切 ----------
test("copySelection 存在并写入 _clipboard（不删源图）", () => {
  assert.ok(/async function copySelection\s*\(/.test(IMG_CODE));
  const fnBody = IMG_CODE.substring(IMG_CODE.indexOf("async function copySelection("));
  // 复制模式下不能出现 apiDeleteItem
  const copyOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function copySelection("), IMG_CODE.indexOf("async function cutSelection("));
  assert.ok(!/apiDeleteItem/.test(copyOnly), "copySelection 里不应调用 apiDeleteItem");
  assert.ok(/_clipboard\s*=\s*snap/.test(copyOnly));
});

test("cutSelection 存在，但只在剪贴板层面打 mode=cut 标记，不立刻删源图", () => {
  assert.ok(/async function cutSelection\s*\(/.test(IMG_CODE));
  const cutOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function cutSelection("), IMG_CODE.indexOf("async function pasteClipboard("));
  // 剪切不应立即删除源图——真正的删除在 pasteClipboard 里
  assert.ok(!/apiDeleteItem/.test(cutOnly),
    "cutSelection 里不应调用 apiDeleteItem（应推迟到粘贴成功后）");
  assert.ok(/snapshotSelection\(\s*["']cut["']\s*\)/.test(cutOnly),
    "cutSelection 应以 mode='cut' 创建快照");
});

// ---------- 粘贴 ----------
test("pasteClipboard 存在，使用快照里的 title 写入新 item", () => {
  assert.ok(/async function pasteClipboard\s*\(/.test(IMG_CODE));
  const pasteOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function pasteClipboard("),
                                         IMG_CODE.indexOf("function syncClipboardBtns("));
  // 粘贴时把快照 title 传给 apiSaveImage
  assert.ok(/apiSaveImage\(activeFolder\.id\s*,\s*newFileName\s*,\s*s\.title/.test(pasteOnly),
    "pasteClipboard 必须把快照里的 s.title 传入 apiSaveImage");
  // 剪切模式下粘贴成功后才删除源图
  assert.ok(/apiDeleteItem\(s\.srcItemId\)/.test(pasteOnly),
    "pasteClipboard 剪切分支应调用 apiDeleteItem 删除源图");
  assert.ok(/_clipboard\s*=\s*null/.test(pasteOnly),
    "剪切粘贴成功后应清空剪贴板");
});

test("pasteClipboard 剪切模式下会更新源夹的 total 计数", () => {
  const pasteOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function pasteClipboard("),
                                         IMG_CODE.indexOf("function syncClipboardBtns("));
  assert.ok(/srcFolder\.total\s*=\s*Math\.max\(0\s*,\s*srcFolder\.total\s*-\s*deleted\)/.test(pasteOnly),
    "剪切粘贴后应更新源夹的 total 计数");
});

// ---------- 按钮显隐 ----------
test("syncClipboardBtns 存在，且根据 selection 和剪贴板状态控制按钮显隐", () => {
  assert.ok(/function syncClipboardBtns\s*\(/.test(IMG_CODE));
  const fnBody = IMG_CODE.substring(IMG_CODE.indexOf("function syncClipboardBtns("));
  assert.ok(/imageCopyBtn\.hidden\s*=\s*!activeFolder\s*\|\|\s*selection\.size\s*===\s*0/.test(fnBody));
  assert.ok(/imageCutBtn\.hidden\s*=\s*!activeFolder\s*\|\|\s*selection\.size\s*===\s*0/.test(fnBody));
  assert.ok(/imagePasteBtn\.hidden/.test(fnBody));
});

test("syncImageToolbarBtns 会调用 syncClipboardBtns（按钮状态统一同步）", () => {
  // 剥离注释后 "/* ---------- 分组 / 解散按钮显隐 ---------- */" 标记消失，
  // 改用「找到本函数之后到下一个 function 声明之间」的窗口
  const startIdx = IMG_CODE.indexOf("function syncImageToolbarBtns(");
  assert.ok(startIdx >= 0, "syncImageToolbarBtns 缺失");
  const nextFnIdx = IMG_CODE.indexOf("function ", startIdx + "function syncImageToolbarBtns(".length);
  const fnBody = IMG_CODE.substring(startIdx, nextFnIdx > 0 ? nextFnIdx : IMG_CODE.length);
  assert.ok(/syncClipboardBtns\s*\(\)/.test(fnBody),
    "syncImageToolbarBtns 应调用 syncClipboardBtns");
});

// ---------- 快捷键 ----------
test("bindKeyboard 绑定 Ctrl+C → copySelection", () => {
  assert.ok(/e\.key\s*===\s*["']c["']/.test(IMG_CODE));
  assert.ok(/copySelection\s*\(\)/.test(IMG_CODE));
});

test("bindKeyboard 绑定 Ctrl+X → cutSelection", () => {
  assert.ok(/e\.key\s*===\s*["']x["']/.test(IMG_CODE));
  assert.ok(/cutSelection\s*\(\)/.test(IMG_CODE));
});

// ---------- paste 事件回退到内部剪贴板 ----------
test("paste 事件在无外部图片时回退到 _clipboard", () => {
  // 找到 paste 事件处理函数
  const pasteIdx = IMG_CODE.indexOf('document.addEventListener("paste"');
  assert.ok(pasteIdx >= 0, "paste 事件监听器缺失");
  const pasteBody = IMG_CODE.substring(pasteIdx, pasteIdx + 2500);
  assert.ok(/_clipboard\s*&&\s*_clipboard\.items\.length/.test(pasteBody),
    "paste 事件应检查内部剪贴板是否非空");
  assert.ok(/pasteClipboard\s*\(\)/.test(pasteBody),
    "paste 事件在无外部图片时应回退到 pasteClipboard");
});

// ---------- 应用内共享剪贴板桥（跨模块：图片夹 → 思维块） ----------
test("publishSharedClip 把快照发布到 window.__glassImgClip", () => {
  assert.ok(/const SHARED_CLIP_KEY = "__glassImgClip"/.test(IMG_CODE), "缺少共享剪贴板键");
  const b = IMG_CODE.substring(IMG_CODE.indexOf("function publishSharedClip("), IMG_CODE.indexOf("async function snapshotSelection("));
  assert.ok(/window\[SHARED_CLIP_KEY\]/.test(b), "应挂到 window 上");
  assert.ok(/owner:\s*"images"/.test(b), "应标记来源为图片夹");
  assert.ok(/items:\s*snap\.items\.map/.test(b), "应携带字节快照");
  assert.ok(/consumeCutSources/.test(b), "剪切应通过 onConsume 复用清理逻辑");
});

test("copySelection / cutSelection 都会发布到共享剪贴板", () => {
  const copyOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function copySelection("), IMG_CODE.indexOf("async function cutSelection("));
  assert.ok(/publishSharedClip\(snap\)/.test(copyOnly), "copySelection 应发布共享剪贴板");
  const cutOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function cutSelection("), IMG_CODE.indexOf("async function pasteClipboard("));
  assert.ok(/publishSharedClip\(snap\)/.test(cutOnly), "cutSelection 应发布共享剪贴板");
});

test("consumeCutSources 抽出剪切清理逻辑，粘贴与跨模块 onConsume 复用", () => {
  assert.ok(/async function consumeCutSources\(/.test(IMG_CODE), "缺少 consumeCutSources");
  const b = IMG_CODE.substring(IMG_CODE.indexOf("async function consumeCutSources("));
  assert.ok(/apiDeleteItem\(s\.srcItemId\)/.test(b), "应删除源图");
  const pasteOnly = IMG_CODE.substring(IMG_CODE.indexOf("async function pasteClipboard("), IMG_CODE.indexOf("function syncClipboardBtns("));
  assert.ok(/consumeCutSources\(snaps\)/.test(pasteOnly), "pasteClipboard 剪切分支应复用 consumeCutSources");
});

// ---------- toolbar 按钮事件绑定 ----------
test("bindToolbar 绑定三个按钮的 click 事件", () => {
  // 剥离注释后注释里的锚点字符串消失，改用「下一个 function 声明」作为窗口终点
  const startIdx = IMG_CODE.indexOf("function bindToolbar(");
  assert.ok(startIdx >= 0, "bindToolbar 缺失");
  const nextFnIdx = IMG_CODE.indexOf("function ", startIdx + "function bindToolbar(".length);
  const fnBody = IMG_CODE.substring(startIdx, nextFnIdx > 0 ? nextFnIdx : IMG_CODE.length);
  assert.ok(/imageCopyBtn\.addEventListener\("click",\s*\(\)\s*=>\s*copySelection/.test(fnBody),
    "imageCopyBtn 未绑定 click → copySelection");
  assert.ok(/imageCutBtn\.addEventListener\("click",\s*\(\)\s*=>\s*cutSelection/.test(fnBody),
    "imageCutBtn 未绑定 click → cutSelection");
  assert.ok(/imagePasteBtn\.addEventListener\("click",\s*\(\)\s*=>\s*pasteClipboard/.test(fnBody),
    "imagePasteBtn 未绑定 click → pasteClipboard");
});

// ---------- BUG 回归：卡片选中后复制卡片下方描述文字，不应被劫持成「复制图片」 ----------
// 场景：图片夹「仅复制图片」后，卡片仍处于选中态；用户再框选 .card-caption 的文字按
// Ctrl+C 想复制文字，但旧逻辑只要 selection.size>0 就 preventDefault + copySelection()，
// 把 __glassImgClip 重新写成图片，导致思维块里粘贴出来的还是图片。
test("image-wall 定义 hasActiveTextSelection（检测非折叠文本选区）", () => {
  assert.ok(/function hasActiveTextSelection\s*\(/.test(IMG_CODE), "缺少 hasActiveTextSelection");
  const b = IMG_CODE.substring(IMG_CODE.indexOf("function hasActiveTextSelection("));
  assert.ok(/getSelection/.test(b), "应通过 window.getSelection 判定");
  assert.ok(/isCollapsed/.test(b), "应检查选区是否为折叠态");
});

test("image-wall Ctrl+C / Ctrl+X 在存在文本选区时不劫持（放行原生复制文字）", () => {
  assert.ok(/const textSelected\s*=\s*hasActiveTextSelection\(\)/.test(IMG_CODE),
    "bindKeyboard 应先计算 textSelected");
  const cBranch = IMG_CODE.substring(
    IMG_CODE.indexOf('e.key === "c"'),
    IMG_CODE.indexOf('e.key === "x"')
  );
  assert.ok(/selection\.size\s*>\s*0\s*&&\s*!textSelected/.test(cBranch),
    "Ctrl+C 分支应在「有选中卡片且无文本选区」时才劫持");
  const xBranch = IMG_CODE.substring(
    IMG_CODE.indexOf('e.key === "x"'),
    IMG_CODE.indexOf('e.key === "m"')
  );
  assert.ok(/selection\.size\s*>\s*0\s*&&\s*!textSelected/.test(xBranch),
    "Ctrl+X 分支应在「有选中卡片且无文本选区」时才劫持");
});

test("mindmap copy 监听器：clipboardData 为空时用 window.getSelection 兜底判定复制文字", () => {
  const idx = MIND_CODE.indexOf("function bindExternalCopyInvalidatesImageClip(");
  assert.ok(idx >= 0, "缺少 bindExternalCopyInvalidatesImageClip");
  const b = MIND_CODE.substring(idx, MIND_CODE.indexOf("async function fallbackPasteClipboardImage("));
  assert.ok(/getSelection/.test(b), "应使用 window.getSelection 兜底");
  assert.ok(/isCollapsed/.test(b), "应检查选区折叠态");
  assert.ok(/window\[SHARED_CLIP_KEY\]\s*=\s*null/.test(b), "命中后应清空共享图片剪贴板");
});

// ---------- 汇总 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);
