/**
 * 本插件的两种安装形态包名（单一来源）。
 *
 * 为什么必须集中：dsh 的 Loader 条目名、客户端模块 id、profile 依赖名三者
 * 是同一个字符串。只要有一处对不上，web boot 就会把插件判成
 * `import failed` 并中止整个应用（issue #3）。
 *
 * 新增 / 修改安装形态时，除了这里，还要同步：
 *   - `lib/client.js` 的固定注册列表（浏览器 bundle 不能 import 本模块）；
 *   - `lib/index.js` 的 `clientGraphSummary`（已引用本模块）；
 *   - `scripts/preflight.mjs`（已引用本模块）；
 *   - 仓库根 `lib/dsh.mjs` 的 `NATIVE_PLUGIN_BUNDLES`；
 *   - 根包 / 子包的 `package.json` name 与各自 `cordis.patch.yml` 的 `name`。
 *
 * 本仓库改名后加了 `-pool` 后缀，避免与上游同名包混淆。旧名继续留在列表里，
 * 只为兼容已经装过旧包的环境。
 *
 * `tests/install-contract.test.mjs` 会把这些点全部对一遍，漏改会直接红。
 */
export const PLUGIN_PACKAGE_NAMES = [
  'dsh-plugin-workbuddy-pool',
  'workbuddy-to-dsh-pool',
  // 兼容旧名：老装法（单文件夹分发 / 早期的 dsh-plugin-workbuddy）升级上来时
  // 目录还在，不认这两个会让 clientGraphSummary 一直报「未组装」。
  'dsh-plugin-workbuddy',
  'workbuddy-to-dsh',
];
