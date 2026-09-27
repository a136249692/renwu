// 回归测试：思维节点内嵌图片
// 用户诉求：
//   1) 思维内容块里可以添加图片，一个内容块可加多张
//   2) 点击可展开图片，展示「一行多列」
//   3) 点击单张图片后可缩放显示（灯箱）
// 覆盖：前端 UI/交互 + localStorage 兜底 + Rust 后端存储命令。
// 运行方式：node test/mind-node-image.test.mjs

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIND = fs.readFileSync(path.join(ROOT, "src/mindmap.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "src/index.html"), "utf8");
const CSS  = fs.readFileSync(path.join(ROOT, "src/styles.css"), "utf8");
const DB   = fs.readFileSync(path.join(ROOT, "src-tauri/src/db.rs"), "utf8");
const LIB  = fs.readFileSync(path.join(ROOT, "src-tauri/src/lib.rs"), "utf8");

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, err: e.message }); }
}
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const CODE = stripComments(MIND);
// 截取某个函数体：从 "function xxx(" 起到下一个顶层 "function " 之前
function fnBody(src, sig) {
  const start = src.indexOf(sig);
  if (start < 0) return "";
  const next = src.indexOf("\nfunction ", start + sig.length);
  return src.substring(start, next > 0 ? next : src.length);
}

// ---------- HTML：输入框与灯箱 ----------
test("HTML 存在节点图片文件输入框（multiple 多选）", () => {
  assert.ok(/id="mind-image-input"/.test(HTML), "mind-image-input 缺失");
  assert.ok(/id="mind-image-input"[^>]*multiple/.test(HTML) || /multiple[^>]*id="mind-image-input"/.test(HTML),
    "mind-image-input 应支持 multiple");
});

test("HTML 存在灯箱骨架（图片 + 缩放工具 + 关闭）", () => {
  assert.ok(/id="mind-lightbox"/.test(HTML));
  assert.ok(/id="mind-lightbox-img"/.test(HTML));
  assert.ok(/id="mind-lightbox-zoom-in"/.test(HTML));
  assert.ok(/id="mind-lightbox-zoom-out"/.test(HTML));
  assert.ok(/id="mind-lightbox-reset"/.test(HTML));
  assert.ok(/id="mind-lightbox-close"/.test(HTML));
});

// ---------- 状态 ----------
test("定义节点图片 localStorage 键与内存状态", () => {
  assert.ok(/LS_NODE_IMGS\s*=\s*"glassCanvas\.mindNodeImgs"/.test(CODE));
  assert.ok(/const nodeImages\s*=\s*new Map\(\)/.test(CODE));
  assert.ok(/const expandedImgs\s*=\s*new Set\(\)/.test(CODE));
});

// ---------- API：SQLite 优先 + localStorage 兜底 ----------
test("apiListMapImages 走 list_map_node_images，兜底按节点集合过滤", () => {
  const b = fnBody(CODE, "async function apiListMapImages(");
  assert.ok(/mi\("list_map_node_images"/.test(b), "应调用 list_map_node_images");
  assert.ok(/lsNodeImgs\.filter/.test(b), "兜底应过滤 lsNodeImgs");
});

test("apiSaveNodeImage 走 save_mindmap_node_image，兜底写 dataURL", () => {
  const b = fnBody(CODE, "async function apiSaveNodeImage(");
  assert.ok(/miStrict\("save_mindmap_node_image"/.test(b), "应调用 save_mindmap_node_image");
  assert.ok(/nodeId/.test(b) && /fileName/.test(b), "应传 nodeId + fileName");
  assert.ok(/glassCanvas\.mindImg\.\$\{im\.file_path\}/.test(b), "兜底应把 dataURL 写入 mindImg 键");
});

test("apiDeleteNodeImage 走 delete_mindmap_node_image 并清理兜底数据", () => {
  const b = fnBody(CODE, "async function apiDeleteNodeImage(");
  assert.ok(/delete_mindmap_node_image/.test(b));
  assert.ok(/localStorage\.removeItem/.test(b));
});

test("apiReadNodeImage 走 read_mindmap_node_image 并生成 blob URL", () => {
  const b = fnBody(CODE, "async function apiReadNodeImage(");
  assert.ok(/read_mindmap_node_image/.test(b));
  assert.ok(/createObjectURL/.test(b));
});

// ---------- 渲染：折叠封面 + 展开一行多列 ----------
test("renderNodeImages 折叠态显示封面缩略图 + 张数角标", () => {
  const b = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/mind-node-cover/.test(b), "缺少折叠封面");
  assert.ok(/cover-count/.test(b), "缺少张数角标");
  assert.ok(/expandedImgs\.has\(n\.id\)/.test(b), "应按 expandedImgs 判断展开态");
});

test("renderNodeImages 展开态渲染一行多列画廊", () => {
  const b = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/mind-node-gallery/.test(b), "缺少画廊容器");
  assert.ok(/mind-node-thumb/.test(b), "缺少缩略图");
});

test("点击画廊缩略图调用 openLightbox（进入缩放查看）", () => {
  const b = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/openLightbox\(im, list\)/.test(b), "缩略图点击应触发 openLightbox");
});

test("展开/收起会重算连线（renderEdges）", () => {
  const b = fnBody(CODE, "function renderNodeImages(");
  assert.ok(b.split("renderEdges()").length - 1 >= 2, "展开与收起都应调用 renderEdges");
});

test("缩略图支持移除（removeNodeImage）", () => {
  const b = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/removeNodeImage\(n,\s*im\)/.test(b), "缩略图应有移除按钮");
});

// ---------- 加图入口 ----------
test("每个节点都有「＋ 图片」入口，点击打开文件选择框", () => {
  const b = fnBody(CODE, "function pickImagesForNode(");
  assert.ok(/_pendingImgNodeId\s*=\s*nodeId/.test(b), "应记录目标节点");
  assert.ok(/mindImageInput\.click\(\)/.test(b), "应触发文件选择框");
  const r = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/makeAddImgBtn\(/.test(r), "节点内应渲染加图按钮");
});

test("addImagesToNode 多选逐张保存，且有大小/空图校验", () => {
  const b = fnBody(CODE, "async function addImagesToNode(");
  assert.ok(/for\s*\(const file of files\)/.test(b), "应支持多选逐个处理");
  assert.ok(/apiSaveNodeImage\(nodeId/.test(b), "应调用 apiSaveNodeImage");
  assert.ok(/30 \* 1024 \* 1024/.test(b), "应有 30MB 上限校验");
});

// ---------- 灯箱缩放 ----------
test("openLightbox / closeLightbox 控制灯箱显隐并重置缩放", () => {
  assert.ok(/async function openLightbox\(/.test(CODE));
  assert.ok(/function closeLightbox\(/.test(CODE));
  const c = fnBody(CODE, "function closeLightbox(");
  assert.ok(/mindLightbox\.hidden\s*=\s*true/.test(c), "关闭应隐藏灯箱");
});

test("lightboxZoomAt 有缩放上下限并写入 transform", () => {
  const b = fnBody(CODE, "function lightboxZoomAt(");
  assert.ok(/Math\.min\(8,\s*Math\.max\(0\.2/.test(b), "缩放应限制在 0.2x~8x");
  assert.ok(/applyLightboxTransform\(\)/.test(b));
  const a = fnBody(CODE, "function applyLightboxTransform(");
  assert.ok(/scale\(\$\{lb\.scale\}\)/.test(a), "transform 应包含 scale");
});

test("bindLightbox 绑定滚轮缩放 / 拖拽平移 / Esc 关闭", () => {
  const b = fnBody(CODE, "function bindLightbox(");
  assert.ok(/"wheel"/.test(b), "应支持滚轮缩放");
  assert.ok(/"pointerdown"/.test(b), "应支持拖拽平移");
  assert.ok(/Escape/.test(b), "应支持 Esc 关闭");
  assert.ok(/lightboxZoomAt\(/.test(b), "工具按钮应触发缩放");
});

// ---------- 交互不冲突 ----------
test("在图片区按下指针不会触发整节点拖动", () => {
  const b = fnBody(CODE, "function downOnNode(");
  assert.ok(/e\.target\.closest\("\.mind-node-imgs"\)/.test(b), "图片区应屏蔽节点拖动");
});

test("删除节点会一并清理其图片状态", () => {
  const b = fnBody(CODE, "async function removeNode(");
  assert.ok(/nodeImages\.delete\(id\)/.test(b), "removeNode 应清理 nodeImages");
  const d = fnBody(CODE, "async function apiDeleteNode(");
  assert.ok(/lsNodeImgs\s*=\s*lsNodeImgs\.filter\(im => im\.node_id !== id\)/.test(d),
    "兜底应删除该节点的图片记录");
});

// ---------- 删除前二次确认（用户诉求：删除思维块/图片前必须确认） ----------
test("删除思维块前先弹 askConfirm，取消则不执行删除", () => {
  const b = fnBody(CODE, "async function removeNode(");
  assert.ok(/await askConfirm\(/.test(b), "removeNode 应先 await askConfirm");
  assert.ok(/if \(!ok\) return;/.test(b), "取消应提前 return，不执行删除");
  // 弹窗文案与主题
  assert.ok(/确定删除思维块/.test(b), "确认文案应说明是删除思维块");
  assert.ok(/不可撤销/.test(b), "文案应提示不可撤销");
  assert.ok(/\{\s*title:\s*"删除思维块"/.test(b), "弹窗 title 应为『删除思维块』");
  // 确认弹窗必须出现在实际删除动作之前（apiDeleteNode / nodeImages.delete）
  const idxAsk = b.indexOf("await askConfirm");
  const idxDel = b.indexOf("apiDeleteNode(id)");
  const idxClear = b.indexOf("nodeImages.delete(id)");
  assert.ok(idxAsk > 0, "应能找到 await askConfirm");
  assert.ok(idxDel > idxAsk, "askConfirm 必须在 apiDeleteNode 之前");
  assert.ok(idxClear > idxAsk, "askConfirm 必须在 nodeImages 清理之前");
});

test("删除思维块前的确认文案包含节点标题（便于用户核对）", () => {
  const b = fnBody(CODE, "async function removeNode(");
  // 从 nodes 里取内容做 label，且对文本做转义/截断
  assert.ok(/nodes\.find\(x => x\.id === id\)/.test(b), "应根据 id 查找节点以取标题");
  assert.ok(/esc\(/.test(b), "标题应经 esc 转义，避免注入");
});

test("删除节点图片前先弹 askConfirm，取消则不执行删除", () => {
  const b = fnBody(CODE, "async function removeNodeImage(");
  assert.ok(/await askConfirm\(/.test(b), "removeNodeImage 应先 await askConfirm");
  assert.ok(/if \(!ok\) return;/.test(b), "取消应提前 return，不执行删除");
  assert.ok(/确定删除这张图片/.test(b), "确认文案应说明是删除图片");
  assert.ok(/不可撤销/.test(b), "文案应提示不可撤销");
  assert.ok(/\{\s*title:\s*"删除图片"/.test(b), "弹窗 title 应为『删除图片』");
  // askConfirm 必须出现在 apiDeleteNodeImage 之前
  const idxAsk = b.indexOf("await askConfirm");
  const idxDel = b.indexOf("apiDeleteNodeImage(im.id)");
  assert.ok(idxAsk > 0 && idxDel > idxAsk, "askConfirm 必须在 apiDeleteNodeImage 之前");
});

// ---------- 样式 ----------
test("CSS：画廊为一行多列（flex nowrap + 横向滚动）", () => {
  assert.ok(/\.mind-node-gallery\s*\{[^}]*flex-wrap:\s*nowrap/.test(CSS));
  assert.ok(/\.mind-node-gallery\s*\{[^}]*overflow-x:\s*auto/.test(CSS));
});

test("CSS：存在灯箱与缩略图样式", () => {
  assert.ok(/\.img-lightbox\s*\{/.test(CSS));
  assert.ok(/\.mind-node-thumb\s*\{/.test(CSS));
  assert.ok(/cursor:\s*zoom-in/.test(CSS));
});

// ---------- Rust 后端 ----------
test("db.rs 建表 mindmap_node_images（带 node_id 外键与索引）", () => {
  assert.ok(/CREATE TABLE IF NOT EXISTS mindmap_node_images/.test(DB));
  assert.ok(/idx_mm_node_images_node/.test(DB));
});

test("db.rs 提供图片的 list/save/delete/read 函数", () => {
  assert.ok(/pub fn list_map_node_images\(/.test(DB));
  assert.ok(/pub fn save_mindmap_node_image\(/.test(DB));
  assert.ok(/pub fn delete_mindmap_node_image\(/.test(DB));
  assert.ok(/pub fn read_mindmap_node_image\(/.test(DB));
  assert.ok(/pub fn delete_node_images\(/.test(DB));
});

test("db.rs 读取带目录穿越防护，文件落在 images/mindmap/ 下", () => {
  const b = DB.substring(DB.indexOf("pub fn read_mindmap_node_image"));
  assert.ok(/starts_with\(&base\)/.test(b), "应校验路径落在 mindmap 根目录内");
  assert.ok(/mindmap_image_root/.test(DB));
  assert.ok(/images\/mindmap|"mindmap"/.test(DB), "相对路径应形如 mindmap/<node_id>/...");
});

test("lib.rs 注册四个思维节点图片命令", () => {
  assert.ok(/list_map_node_images,/.test(LIB));
  assert.ok(/save_mindmap_node_image,/.test(LIB));
  assert.ok(/delete_mindmap_node_image,/.test(LIB));
  assert.ok(/read_mindmap_node_image,/.test(LIB));
});

test("lib.rs 删除节点/导图会清理图片物理文件", () => {
  const delNode = LIB.substring(LIB.indexOf("fn delete_mindmap_node"), LIB.indexOf("fn list_mindmap_edges"));
  assert.ok(/delete_node_images/.test(delNode), "删节点应取回图片路径");
  assert.ok(/remove_file/.test(delNode), "删节点应删物理文件");
  const delMap = LIB.substring(LIB.indexOf("fn delete_mindmap("), LIB.indexOf("fn list_mindmap_nodes"));
  assert.ok(/remove_file/.test(delMap), "删导图应删物理文件");
});

// ---------- Ctrl/⌘+V 粘贴图片 ----------
test("绑定 document paste：仅在思维模式且有导图时响应，输入框内放行", () => {
  const b = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/addEventListener\("paste"/.test(b), "应监听 paste");
  assert.ok(/mindPane\.hidden \|\| !activeMap/.test(b), "应限定在思维模式且有导图");
  assert.ok(/INPUT/.test(b) && /TEXTAREA/.test(b), "输入框/文本域内应放行默认粘贴");
});

test("paste 从剪贴板提取图片文件并写入编辑中/选中的节点", () => {
  const b = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/cd\.items/.test(b), "应读取 clipboardData.items");
  assert.ok(/getAsFile\(\)/.test(b), "应取出图片文件");
  assert.ok(/e\.preventDefault\(\)/.test(b), "有图片时应阻止默认粘贴");
  assert.ok(/editingNode \? editingNode\.id : selectedNodeId/.test(b), "应定位到编辑中/选中的节点");
  assert.ok(/addImagesToNode\(targetId, files\)/.test(b), "应调用 addImagesToNode 落库");
});

test("init 注册了 paste 绑定", () => {
  assert.ok(/bindImagePaste\(\);/.test(CODE), "init 应调用 bindImagePaste");
});

// ---------- 灯箱多图切换 ----------
test("HTML 灯箱含上一张/下一张按钮与计数", () => {
  assert.ok(/id="mind-lightbox-prev"/.test(HTML), "缺少上一张按钮");
  assert.ok(/id="mind-lightbox-next"/.test(HTML), "缺少下一张按钮");
  assert.ok(/id="mind-lightbox-count"/.test(HTML), "缺少计数");
});

test("openLightbox 接收同块图片列表，缩略图点击传入列表", () => {
  const b = fnBody(CODE, "async function openLightbox(");
  assert.ok(/lb\.list = arr/.test(b), "应记录图片集合");
  assert.ok(/showLightboxImage\(idx\)/.test(b), "应展示当前图片");
  const r = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/openLightbox\(im, list\)/.test(r), "缩略图点击应把同块列表传给灯箱");
});

test("showLightboxImage 下标循环切换并重置缩放", () => {
  const b = fnBody(CODE, "async function showLightboxImage(");
  assert.ok(/lb\.index = \(\(i % n\) \+ n\) % n/.test(b), "下标应循环");
  assert.ok(/lb\.scale = 1; lb\.tx = 0; lb\.ty = 0/.test(b), "切换应重置缩放/平移");
  assert.ok(/updateLightboxChrome\(\)/.test(b), "切换后应刷新计数与按钮");
});

test("lightboxStep 仅多图切换；updateLightboxChrome 控制显隐与计数", () => {
  const s = fnBody(CODE, "function lightboxStep(");
  assert.ok(/lb\.list\.length <= 1/.test(s), "单图不切换");
  const u = fnBody(CODE, "function updateLightboxChrome(");
  assert.ok(/mindLightboxPrev\.hidden = !multi/.test(u), "多图才显示上一张");
  assert.ok(/mindLightboxNext\.hidden = !multi/.test(u), "多图才显示下一张");
  assert.ok(/lb\.index \+ 1/.test(u) && /\$\{n\}/.test(u), "计数应形如 当前 / 总数");
});

test("灯箱绑定左右按钮与 ←/→ 快捷键", () => {
  const b = fnBody(CODE, "function bindLightbox(");
  assert.ok(/mindLightboxPrev\.addEventListener/.test(b), "应绑定上一张按钮");
  assert.ok(/mindLightboxNext\.addEventListener/.test(b), "应绑定下一张按钮");
  assert.ok(/"ArrowLeft"/.test(b), "应支持 ← 切换");
  assert.ok(/"ArrowRight"/.test(b), "应支持 → 切换");
});

test("CSS：灯箱导航按钮与计数样式存在", () => {
  assert.ok(/\.lb-nav\s*\{/.test(CSS), "缺少 .lb-nav");
  assert.ok(/\.lb-prev\s*\{[^}]*left/.test(CSS), "缺少 .lb-prev 定位");
  assert.ok(/\.lb-count\s*\{/.test(CSS), "缺少 .lb-count");
});

// ---------- 跨思维块复制 / 剪切 / 粘贴 ----------
test("定义思维块图片剪贴板状态与字节读取", () => {
  assert.ok(/let _mindClip = null/.test(CODE), "缺少 _mindClip");
  assert.ok(/async function apiReadNodeImageBytes\(/.test(CODE), "缺少 apiReadNodeImageBytes");
  assert.ok(/function base64ToBytes\(/.test(CODE), "缺少 base64ToBytes 兜底解码");
});

test("renderNodeImages 缩略图提供复制/剪切入口", () => {
  const r = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/thumb-acts/.test(r), "缺少悬停操作条");
  assert.ok(/copyNodeImage\(n, im, "copy"\)/.test(r), "缺少复制按钮");
  assert.ok(/copyNodeImage\(n, im, "cut"\)/.test(r), "缺少剪切按钮");
});

test("copyNodeImage 快照图片字节并标记 copy/cut", () => {
  const b = fnBody(CODE, "async function copyNodeImage(");
  assert.ok(/apiReadNodeImageBytes\(im\.file_path\)/.test(b), "应读取原图字节");
  assert.ok(/_mindClip = \{/.test(b) && /mode,/.test(b), "应写入剪贴板并记录模式");
  assert.ok(/refreshAllNodeImages\(\)/.test(b), "复制后应刷新各节点的「粘贴」按钮");
});

test("pasteNodeImages 贴入目标块；剪切模式成功后才删源图并清空剪贴板", () => {
  const b = fnBody(CODE, "async function pasteNodeImages(");
  assert.ok(/new File\(\[it\.bytes\]/.test(b), "应把字节还原为文件");
  assert.ok(/addImagesToNode\(targetNodeId, files\)/.test(b), "应落到目标节点");
  assert.ok(/const isCut = _mindClip\.mode === "cut"/.test(b), "应区分剪切模式");
  assert.ok(/apiDeleteNodeImage\(it\.id\)/.test(b), "剪切应在粘贴成功后删源图");
  assert.ok(/_mindClip = null/.test(b), "剪切粘贴后应清空剪贴板");
});

test("appendPasteBtn 仅在剪贴板非空时追加「粘贴」按钮", () => {
  const b = fnBody(CODE, "function appendPasteBtn(");
  assert.ok(/_mindClip\.items\.length/.test(b), "应判断剪贴板非空");
  assert.ok(/mind-node-paste-img/.test(b), "缺少粘贴按钮样式类");
  assert.ok(/pasteNodeImages\(nodeId\)/.test(b), "点击应触发粘贴");
  const r = fnBody(CODE, "function renderNodeImages(");
  assert.ok(/appendPasteBtn\(/.test(r), "各节点操作条应追加粘贴按钮");
});

test("paste 事件在无外部图片时回退到应用内剪贴板", () => {
  const b = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/_mindClip/.test(b), "应检查应用内剪贴板");
  assert.ok(/pasteNodeImages\(targetId\)/.test(b), "应调用 pasteNodeImages");
});

test("CSS：缩略图复制/剪切按钮与粘贴按钮样式存在", () => {
  assert.ok(/\.mind-node-thumb \.thumb-acts\s*\{/.test(CSS), "缺少 .thumb-acts");
  assert.ok(/\.thumb-act\s*\{/.test(CSS), "缺少 .thumb-act");
  assert.ok(/\.mind-node-paste-img\s*\{/.test(CSS), "缺少 .mind-node-paste-img");
});

// ---------- 从任意位置粘贴图片（截图 / 网页 / 图片夹复制的图） ----------
test("paste 兜底：HTML 图片、图片 URL、系统剪贴板 API", () => {
  const b = fnBody(CODE, "async function clipboardImageFallbacks(");
  assert.ok(/getData\("text\/html"\)/.test(b), "应读取 text/html");
  assert.ok(/parseClipboardHtml\(/.test(b), "应解析 HTML 里的 <img>");
  assert.ok(/isImageUrl\(/.test(b), "应识别图片 URL");
  assert.ok(/navigator\.clipboard\.read/.test(b), "应调用系统剪贴板 API 兜底");
  const p = fnBody(CODE, "function parseClipboardHtml(");
  assert.ok(/querySelectorAll\("img\[src\]"\)/.test(p), "应取出 <img src>");
});

test("只在 HTML 无可见文字时才当图片，避免抢了富文本/纯文本粘贴", () => {
  const b = fnBody(CODE, "async function clipboardImageFallbacks(");
  assert.ok(/text\.trim\(\)/.test(b), "应按 HTML 可见文字判断");
});

test("urlToImageFile 支持 data: / blob: / http(s)，并校验确为图片", () => {
  const b = fnBody(CODE, "async function urlToImageFile(");
  assert.ok(/data:image/.test(b) && /blob:/.test(b), "应支持 data:/blob:");
  assert.ok(/fetch\(src\)/.test(b), "应 fetch 取回图片内容");
  assert.ok(/\^image/.test(b), "应校验 blob 为 image/*");
});

test("bindImagePaste 无图片文件时走兜底，并回退到共享剪贴板", () => {
  const b = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/clipboardImageFallbacks\(cd\)/.test(b), "无图片文件时应走兜底");
  assert.ok(/readSharedClip\(\)/.test(b), "应检查应用内共享剪贴板");
  assert.ok(/pasteSharedImages\(targetId\)/.test(b), "应回退到 pasteSharedImages");
});

test("共享剪贴板桥：读取 window.__glassImgClip 并按剪切语义清理", () => {
  assert.ok(/const SHARED_CLIP_KEY = "__glassImgClip"/.test(CODE), "缺少共享剪贴板键");
  const r = fnBody(CODE, "function readSharedClip(");
  assert.ok(/window\[SHARED_CLIP_KEY\]/.test(r), "应读取挂在 window 上的桥");
  const p = fnBody(CODE, "async function pasteSharedImages(");
  assert.ok(/addImagesToNode\(targetNodeId, files\)/.test(p), "应贴入目标节点");
  assert.ok(/onConsume/.test(p), "剪切应回调源模块清理源图");
  assert.ok(/window\[SHARED_CLIP_KEY\] = null/.test(p), "剪切后应清空共享剪贴板");
});

test("addImagesToNode 返回成功张数；剪切仅在实际贴成功后才删源", () => {
  const b = fnBody(CODE, "async function addImagesToNode(");
  assert.ok(/return ok/.test(b), "addImagesToNode 应返回成功张数");
  assert.ok(/!isCut \|\| !ok/.test(b), "剪切但未贴成功不应删源图");
});

test("编辑文字且剪贴板是纯文本时不劫持（保留文本粘贴）", () => {
  const b = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/getData\("text\/plain"\)/.test(b), "应读取 text/plain");
  assert.ok(/isContentEditable/.test(b), "应判断是否正在编辑文字");
  assert.ok(/plainText\.trim\(\)\s*&&\s*editingText/.test(b), "文本粘贴应让行给默认行为");
});

// ---------- 去掉思维图片的「下载 / 另存为」 ----------
test("思维图片不提供下载：封面/缩略图/灯箱均禁用右键另存与拖拽", () => {
  const b = fnBody(CODE, "function forbidImageDownload(");
  assert.ok(/draggable = false/.test(b), "应设置 draggable=false");
  assert.ok(/contextmenu/.test(b), "应禁用原生右键「另存为/下载」菜单");
  assert.ok(/dragstart/.test(b), "应禁用拖拽保存");
  const r = CODE.substring(CODE.indexOf("function renderNodeImages("), CODE.indexOf("function makeAddImgBtn("));
  assert.ok(/forbidImageDownload\(img\)/.test(r), "封面/缩略图应套用 forbidImageDownload");
  const lb = CODE.substring(CODE.indexOf("function bindLightbox("), CODE.indexOf("function bindImagePaste("));
  assert.ok(/forbidImageDownload\(mindLightboxImg\)/.test(lb), "灯箱图应套用 forbidImageDownload");
});

// ---------- 截图粘贴：桌面端后端剪贴板兜底 ----------
test("Rust 提供 read_clipboard_image 命令并已注册", () => {
  assert.ok(/fn read_clipboard_image\(\)/.test(LIB), "缺少 read_clipboard_image 命令");
  assert.ok(/arboard::Clipboard::new\(\)/.test(LIB), "应用 arboard 读系统剪贴板");
  assert.ok(/get_image\(\)/.test(LIB), "应调用 get_image");
  assert.ok(/read_clipboard_image,/.test(LIB), "命令未注册到 generate_handler");
  const cargo = fs.readFileSync(path.join(ROOT, "src-tauri/Cargo.toml"), "utf8");
  assert.ok(/^arboard\s*=/m.test(cargo), "Cargo.toml 缺少 arboard 依赖");
});

test("前端：后端剪贴板图片兜底 + 键盘兜底（WebView 不派发 paste 时）", () => {
  assert.ok(/invokeImpl\("read_clipboard_image"\)/.test(CODE), "缺少读剪贴板图片的 invoke");
  const b = fnBody(CODE, "async function apiReadClipboardImage(");
  assert.ok(/getUint32\(0, true\)/.test(b) && /getUint32\(4, true\)/.test(b), "应解析 width/height");
  assert.ok(/rgbaToPngFile\(/.test(b), "应把 RGBA 转成 PNG File");
  const fb = fnBody(CODE, "async function clipboardImageFallbacks(");
  assert.ok(/apiReadClipboardImage\(\)/.test(fb), "兜底链应含后端读剪贴板");
  const kb = fnBody(CODE, "function bindImagePaste(");
  assert.ok(/_sawPasteEvent\s*=\s*true/.test(kb), "paste 事件应标记已到达");
  assert.ok(/fallbackPasteClipboardImage\(\)/.test(kb), "应调度键盘兜底");
});

// ---------- 汇总 ----------
const passed = results.filter(r => r.pass).length;
const failed = results.length - passed;
for (const r of results) {
  console.log(r.pass ? `  ✓  ${r.name}` : `  ✗  ${r.name}\n     ${r.err}`);
}
console.log(`\n  ${passed}/${results.length} 通过, ${failed} 失败`);
if (failed > 0) process.exit(1);