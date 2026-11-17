# 发布到 GitHub 的清单

这份文件是给**发布者自己**看的上手步骤，不是插件文档。发布完成后删掉即可。

## 一、发布前必做的两件事

### 1. 替换 USERNAME

仓库地址里有 `USERNAME` 占位符，共 6 处：

```powershell
cd <你的发布目录>
# 先看一眼都有哪几处
Select-String -Path package.json,README.md -Pattern USERNAME

# 确认无误后一次性替换（把 your-github-name 换成你的用户名）
$name = 'your-github-name'
Get-ChildItem package.json,README.md | ForEach-Object {
  $t = [System.IO.File]::ReadAllText($_.FullName, (New-Object System.Text.UTF8Encoding($false)))
  $t = $t.Replace('USERNAME', $name)
  [System.IO.File]::WriteAllText($_.FullName, $t, (New-Object System.Text.UTF8Encoding($false)))
}
Select-String -Path package.json,README.md -Pattern USERNAME   # 应无输出
```

### 2. 跑泄漏扫描（硬门槛）

```powershell
cd <你的发布目录>
node scripts/leak-scan.mjs
```

必须看到 `✅ 干净`。有任何一行报错都不要推。

它检查两类问题：

| 类别 | 检查什么 |
|---|---|
| 文件级 | `.log` / `.jsonl` / `.cred` / `workbuddy-pool.json` / `.credentials.yaml` / `.tgz` / `.bak` |
| 内容级 | UUID 形式的账号 id、`C:\Users\<名>` 绝对路径、号池令牌、硬编码 Bearer |

> 这一关不是形式主义。上一版就发生过 `bridge.log`（1.5 MB，含 7 个账号 uid
> 和上游响应体）被打进 tarball 的事故。

## 二、推送到 GitHub

```powershell
cd <你的发布目录>

# 首次
git init
git add -A
git commit -m "dsh-plugin-workbuddy-pool 2.1.0"

# 建远程仓库后
git remote add origin https://github.com/<你的用户名>/dsh-plugin-workbuddy-pool.git
git branch -M main
git push -u origin main
```

**提交前再跑一次 `git status`**，确认暂存区里没有：

- `*.log`（被 `.gitignore` 挡住，但确认一下）
- `package.json.bak-*`
- `node_modules/`

## 三、仓库里该有什么 / 不该有什么

### 该有

```
package.json          ← 核心
cordis.patch.yml      ← dsh 加载入口
lib/                  ← 宿主端 + 客户端
scripts/              ← 工具（含 leak-scan.mjs）
vendor/               ← 桥与控制台的冻结快照
README.md
LICENSE
.npmignore
.gitignore
```

### 不该有

| 文件 | 为什么 |
|---|---|
| `vendor/bridge/bridge.log` | 追加写了上游响应体和账号 uid |
| `vendor/dashboard/console.log` | 含本机绝对路径 |
| `*.tgz` | 打包产物，走 Releases |
| `node_modules/` | 依赖 |
| `package.json.bak-*` | 本机备份 |
| `profiles/web/cordis.patch.yml` | **你的实际 provider/model 绑定，绝对不能提交** |

## 四、发布 npm 包（可选）

`package.json` 里现在是 `"private": true`。要发 npm 就改掉：

```jsonc
{
  "private": false,
  "publishConfig": { "access": "public", "registry": "https://registry.npmjs.org/" }
}
```

然后：

```powershell
npm run leak-scan
npm pack          # 先检查 tarball 内容
tar -tzf dsh-plugin-workbuddy-pool-2.1.0.tgz
npm login
npm publish
```

## 五、打 Release

```powershell
npm pack
# 生成 dsh-plugin-workbuddy-pool-2.1.0.tgz（约 1.0 MB）
```

在 GitHub 建 tag `v2.1.0`，把 tgz 传到 Release 附件。用户就能用：

```
设置 → 插件 → 添加插件 → 填 https://github.com/<用户名>/dsh-plugin-workbuddy-pool/releases/download/v2.1.0/dsh-plugin-workbuddy-pool-2.1.0.tgz
```

## 六、README 里需要你补的两处

1. **截图**：README 第 397 行引用 `docs/plugin-panel-models-detail.png`，
   该文件不在本仓库里。要么补图到 `docs/`，要么删掉那行 `<img>`。
2. **验证记录**：README 结尾提到「本机已验证」，如果不想公开自己的环境细节，
   可以把那一节精简成「已在 Windows + dsh 2.x 上验证通过」。

## 七、改名带来的注意事项

包名从 `dsh-plugin-workbuddy` 改成 `dsh-plugin-workbuddy-pool`，以下位置**已经同步**：

- `package.json` → `name`
- `cordis.patch.yml` → `name`
- `lib/packageNames.mjs` → `PLUGIN_PACKAGE_NAMES`（**旧名保留**，兼容老装法）
- `lib/client.js` → 客户端模块 id 注册列表（**旧名保留**）
- `vendor/lib/dsh.mjs` → `NATIVE_PLUGIN_BUNDLES`（**旧名保留**）

升级已有安装时，旧目录要被清掉，否则会出现两个桥同时抢 8790 端口。步骤：

```powershell
# 1. 改 profile 的 package.json 依赖与 bundles 里的包名
# 2. pnpm install
# 3. 停掉旧目录残留的桥进程（父进程已死的孤儿）
# 4. 删旧目录
Remove-Item "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-plugin-workbuddy" -Recurse -Force
# 5. 重启 dsh
```

## 八、启动 dsh 的三个硬性约束（踩过的坑，务必写进 README）

这三条不是本插件的 bug，但会让人以为是本插件坏了。实测代价很高，写清楚能省很多支持成本。

### 1. 不要在沙箱 / 受限令牌环境里启动 dsh

如果 dsh 的父进程是某种沙箱（例如 IDE 的 embedded agent、受限令牌的 subprocess），
整条进程链会继承**受限令牌**，并出现两个看起来毫不相关的故障：

- `pwsh` / `node` 等工具的每次调用都返回 `spawn EPERM` —— 执行器等于废了；
- 主账号读不到凭据，面板显示「桥未运行 / 积分 —」，桥的 `/health` 返回
  `no usable credential (auto): desktop: EPERM: operation not permitted, open '...workbuddy-desktop.info'`。

原因：受限令牌要做两轮访问检查，`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth`
上没有给沙箱组的显式授权项，第一轮就过不去。而 `~\.dsh` 和 `~\.workbuddy-bridge`
上通常已有这条授权，所以**池内账号正常、只有主账号失效** —— 这个不对称很容易误导排查方向。

判断方法（在 dsh 里跑）：

```powershell
$id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
[bool]($id.Groups | Where-Object { $_.Value -eq 'S-1-5-32-544' })   # False = 受限令牌
try { [IO.File]::ReadAllBytes("$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info").Length } catch { $_.Exception.Message }
```

两条命令都失败，就是这个原因。**解法：从自己的终端启动 dsh**，不要在沙箱里启。

### 2. 不要在 dsh 自己的工具调用里重启 dsh

改插件必须重启 dsh 才生效，而 `pwsh` 工具是 dsh 的子进程。在工具里重启 dsh
等于杀掉执行器本身；如果用 `Start-Process` 拉起新实例，它会变成**孤儿**并继续占着
3080，下一次启动直接 `EADDRINUSE`，所有依赖 `webServer` 的插件全部卡在 pending。

正确做法：把重启写成一个脚本，**由用户在外部终端执行**。

### 3. 装插件前必须杀掉桥进程

`pnpm install` 会被插件目录里正在运行的桥进程挡住，报
`ERR_PNPM_EPERM ... rename '..._tmp_...'`。顺序必须是 **停 → 装 → 启**，不是「启 → 装」。

另外：`pnpm` 在 `Already up to date` 时不会重新解包 tarball，换版本要
`pnpm install --force --no-frozen-lockfile`，或先删目录。
