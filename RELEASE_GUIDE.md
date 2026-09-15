# Task Manager 发布手册

一份"照着做就行"的发布流程。每次发版照这个走，不要再从零摸索。

## 0. 一图流：最小发布动作

```
改代码 → 升 3 处版本号 → commit → 打 tag → push tag → 等 CI 完成
```

只要 5 个 commit 动作；不用本地编译，不用本地签名，CI 全部包办。

---

## 1. 升版本号（3 个地方，缺一不可）

版本必须一致，否则 CI 会产出错乱的产物名。

| 文件 | 字段 | 位置 |
|---|---|---|
| `package.json` | `"version"` | 顶层 |
| `package-lock.json` | `"version"` | 顶层 + `packages."".version`（**两处**） |
| `src-tauri/tauri.conf.json` | `"version"` | 顶层 |

一条命令批量替换（`X.Y.Z` 换成新版本）：

```bash
OLD=1.0.10
NEW=1.0.11
sed -i "s/${OLD}/${NEW}/g" package.json package-lock.json src-tauri/tauri.conf.json
```

验证：
```bash
grep -n '"version"' package.json package-lock.json src-tauri/tauri.conf.json
```

---

## 2. 提交 + 打 tag

```bash
git add -A
git commit -m "chore(release): vX.Y.Z - <一句话说明>"
git tag -a vX.Y.Z -m "vX.Y.Z - <一句话说明>"
git push origin main vX.Y.Z
```

CI 由 tag push 触发（`.github/workflows/tauri-build.yml` 的 `on.push.tags: ["v*"]`）。

---

## 3. 签名密钥（关键，出问题基本都是这里）

### 3.1 当前密钥

- **Key ID**: `B6E7D4013E1BBF46`
- **Public key**（已写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`）
- **Private key**：保存在 GitHub Secrets 里，不落地代码库

### 3.2 生成新密钥（只在轮换时用）

```bash
npx tauri signer generate --ci --password ""
```

产出两行 Base64：一行 private（前缀 `untrusted comment: rsign encrypted secret key`），一行 public（前缀 `untrusted comment: minisign public key: <ID>`）。**private 和 public 必须成对使用**——Tauri 2 里 rsign 签 + minisign 验是标准组合，`Cargo.toml` 不需要开 feature。

### 3.3 把新密钥落到仓库

1. 复制 **public** 替换 `src-tauri/tauri.conf.json` 里 `plugins.updater.pubkey` 那一行整段 Base64。
2. 把 **private** 粘到 GitHub → Settings → Secrets and variables → Actions → `TAURI_SIGNING_PRIVATE_KEY`。
3. `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 保持 **空字符串**（CI 里已写死 `""`；除非你重新生成密钥时用了密码）。
4. commit + tag 走正常流程。

### 3.4 轮换密钥的副作用（重要）

**换 pubkey 后，老版本客户端无法自动更新到新版本**——Tauri updater 不支持多密钥，老客户端只认原来的 pubkey，验不了新签名的产物。

处理办法：
- 老客户端用户手动下载安装新版。
- 发版说明里明确写"vX.Y 起密钥轮换，请手动升级"。
- 除非必要，不要轮换密钥。

---

## 4. GitHub Secrets 清单

| Secret | 用途 | 值 |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | updater 签名（private 部分 Base64） | 当前 Key ID `B6E7D4013E1BBF46` 对应的私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 密钥密码 | 留空字符串（不生成密码时就是空） |
| `CNB_TOKEN` | 上传到 CNB 镜像仓 | CNB 个人 access token，需 `repo` 权限 |

GitHub release 本身用 `GITHUB_TOKEN`（CI 自动注入，无需手动配）。

---

## 5. CI 流水线

`.github/workflows/tauri-build.yml` 两个 job：

1. **build-and-release**（`windows-latest`，约 9–10 分钟）
   - Node 20 + Rust stable + `npm ci`
   - `tauri-apps/tauri-action@v0`：构建 exe / msi、签名、生成 `latest.json`、上传 release
   - 关键 env：`TAURI_SIGNING_PRIVATE_KEY` 从 secret 或手动 dispatch 输入取；`TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`

2. **upload-to-cnb**（`ubuntu-latest`，约 49 秒）
   - 从 GitHub release 下载 5 个产物：`latest.json`、exe、exe.sig、msi、msi.sig
   - 走 CNB REST API 建 tag / release / 上传资源
   - 把 `latest.json` 里 GitHub URL 全替换成 CNB URL，用 `gh release upload --clobber` 覆写 GitHub 那份

CNB 镜像仓：`shiyishi-2026/surenwu`
GitHub 源仓：`a136249692/renwu`

**手动重跑**：Actions → Release → Run workflow → 输入 `tag_name` 和（可选）`signing_key`。

---

## 6. 监控 CI

GitHub API 匿名配额是 60/h，跑一会儿就 403。**别用 API，直接抓 HTML 页面**：

```bash
RUN_ID=34847079080
URL="https://github.com/a136249692/renwu/actions/runs/${RUN_ID}"
curl -s --max-time 10 "$URL" | grep -oE 'aria-label="(completed|currently running): "[^"]+"' | head -1
```

- `currently running` → 还在跑
- `completed` → 看页面里 `Status Success` / `Status Failure`

或者最简单：打开 https://github.com/a136249692/renwu/actions 页面肉眼盯一下。

---

## 7. 常见坑 & 解法

| 现象 | 原因 | 解法 |
|---|---|---|
| `failed to decode secret key: incorrect updater private key password` | Secret 里放的密钥带密码，但 workflow 传空 | 生成新密码less 密钥（`--password ""`），或把密码填到 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` secret |
| 只改了 `package.json`，tag 推上去产物名不对 | 3 处版本号不一致 | 见 §1，`sed` 一次全改 |
| 老用户报"更新失败/签名不匹配" | 换了 pubkey，老客户端认不出 | §3.4；不轮换密钥就不会发生 |
| CI 用 API 查状态一直 403 | GitHub 匿名 API 配额打光 | §6 抓 HTML |
| `npx tauri signer generate --non-interactive` 报 `unexpected argument` | flag 名不对 | 用 `--ci --password ""` |
| 手动 dispatch 时忘记带 `signing_key` 且 Secret 也没配 | updater 无法签名 | 优先配 Secret；临时用 dispatch 输入 `signing_key` 也能兜底 |
| CNB upload job 挂在 "release likely exists" | 重复发布同一 tag | CNB job 已经处理了 409/200 幂等，一般不会挂；若真挂，删掉 CNB 那个 tag/release 再重跑 |

---

## 8. 发布后自检清单

- [ ] GitHub release 页能看到 5 个产物：exe / exe.sig / msi / msi.sig / latest.json
- [ ] `latest.json` 里 URL 已指向 CNB（`cnb.cool/...`），不是 `github.com/...`
- [ ] CNB 对应 tag 也有同样 5 个产物（`https://cnb.cool/shiyishi-2026/surenwu/-/releases` 验证）
- [ ] `package.json` / `package-lock.json` ×2 / `tauri.conf.json` 版本号一致
- [ ] Git tag `vX.Y.Z` 已推送到 remote

---

## 9. 版本史（简）

| 版本 | 说明 |
|---|---|
| 1.0.10 | 便利贴墙 + 新签名密钥（Key ID `B6E7D4013E1BBF46`）；CI 全流程跑通 |
| 1.0.9 | 尝试加便利贴但签名密钥配置错，CI 失败，tag 已删除 |
| 1.0.8 及之前 | 使用旧签名密钥（Key ID `CA8D2B62A1CA54EA`），已随 1.0.10 轮换失效 |
