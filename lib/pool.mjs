/**
 * 号池 —— 多个 WorkBuddy 账号共用一个模型分组，随时切换。
 *
 * ## 架构（2.2.0 起）
 *
 * 一个桥进程 = 一份凭据（`WORKBUDDY_CREDENTIAL_SOURCE=plugin` + 独立
 * `WORKBUDDY_DATA_DIR` / `WORKBUDDY_CREDENTIAL_DIR`），所以 N 个账号 = N 个桥，
 * 各自占一个回环端口。主账号（桌面端凭据）仍归插件自己那个桥（默认 8790）。
 *
 * **N 个桥，但只有一条 provider 路由。** 槽位注册成 `workbuddy-b/c/d…` 会让
 * 模型选择器里多出一串分组，用户明确不要（「不用在选择模型的时候这么多选项」）。
 * 所以槽位只是「同一个 `workbuddy` 路由背后可切换的账号」：桥照样起、令牌照样
 * 各自独立，但 `ctx.llm` 里只登记主账号那一条。
 *
 * 切换靠 `activeClient()`：主适配器的 `ensureReady` 每次请求前问一句「现在该用
 * 谁的桥」，回 `null` 就用主账号。`WorkBuddyAdapter` 只在构造时记一次 client
 * （adapter.mjs:688），之后对话和目录都经 `await this.ensureReady()`
 * （adapter.mjs:838 / 1220），所以换账号不需要重建 adapter，更不需要改宿主。
 *
 * 为什么这点很重要：旧实现（每个槽位注册一条 provider）必须靠改 dsh 的
 * `@deepseek-ai/dsh-client-ui-model-selection` 把那些分组过滤掉，而那文件在
 * `npm install` / dsh 升级时会被整包重写 —— 补丁静默消失，选择器里又冒出一串
 * 号池分组。现在的方案对宿主零依赖，升级怎么升都还在。
 *
 * ## 令牌
 *
 * 每个 slot 一个 `tokenRef`，值存在 dsh credentials（`.credentials.yaml` 的
 * refs 段）。**永远不要把它回给浏览器** —— 对外只报 `configured`。
 */
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { BridgeClient, BridgeSupervisor } from './bridge.mjs';

/** 令牌形状（与插件 bridge.mjs 的本地令牌同口径）。 */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{16,}$/;
/** 令牌解析缓存：切号后新令牌可能刚写进 credentials，1 分钟足够跟上。 */
const TOKEN_TTL_MS = 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 批量加号的上限与间隔。
 *
 * 上限 8：每个号是一个独立桥进程（约 80–120 MB 常驻），再多人先受不了；
 * 而且上游对「同一出口 IP 连续申请设备码」有明显限流，加多了也拿不到码。
 * 间隔 1.2 秒：实测连续请求会有一条被 429，串行留间隔反而整体更快。
 */
const MAX_BATCH_LOGIN = 8;
const BATCH_LOGIN_GAP_MS = 1200;

/**
 * 自动切号（第 6 项）的三个默认值。
 *
 * 为什么默认「到期优先」而不是「余额最多优先」：用户的钱包是按包拆的，每个包
 * 各自到期，`total` 只是求和。余额最多的号往往有一个很晚才到期的长期包垫底，
 * 先烧它等于把快过期的那部分留在原地等死。所以排序键是**最近到期包里还剩多少
 * 钱、以及还有几天到期**，而不是 total。
 *
 * 阈值 300 是经验值：一次复杂对话几十到一百多分，300 留够余量又不至于浪费。
 * 空闲期 90 秒：回答结束后用户常常紧接着追问，太快切会打断连续对话。
 */
const SWITCH_DEFAULT_THRESHOLD = 300;
const SWITCH_DEFAULT_MODE = 'expiry';
const SWITCH_IDLE_MS = 90_000;
const SWITCH_TICK_MS = 60_000;
const SWITCH_MIN_GAP_MS = 120_000;

/** 读 pool.json；不存在/坏档 → 空配置（号池功能自然后退成「只有主账号」）。 */
export function readPoolFile(file, log = () => {}) {
  if (!file) return { file: '', data: null };
  try {
    if (!existsSync(file)) return { file, data: null };
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { file, data: raw && typeof raw === 'object' ? raw : null };
  } catch (error) {
    log(`号池配置读取失败：${file}`, String(error?.message || error));
    return { file, data: null, error: String(error?.message || error) };
  }
}

/** 写回 pool.json（保留原有字段与顺序，只换 slots）。 */
export function writePoolFile(file, data) {
  const text = JSON.stringify(data, null, 2) + '\n';
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/**
 * 归一化一条 slot：
 *   name     槽位短名（b/c/d…），用来拼目录名与默认 provider
 *   port     回环端口，一个桥一个端口
 *   provider dsh 模型选择器里的 provider id（缺省 workbuddy-<name>）
 *   tokenRef credentials 里的引用名（缺省 WORKBUDDY_POOL_<NAME>_TOKEN）
 *   label    面板里显示的名字（缺省「号池 <NAME>」）
 */
export function normalizeSlot(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!name) return null;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const provider = String(raw.provider || `workbuddy-${name}`).trim() || `workbuddy-${name}`;
  const tokenRef = String(raw.tokenRef || `WORKBUDDY_POOL_${name.toUpperCase()}_TOKEN`).trim();
  const label = String(raw.label || `号池 ${name.toUpperCase()}`).trim();
  return {
    name,
    port,
    provider,
    tokenRef,
    label,
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : index,
    enabled: raw.enabled !== false,
    autoCheckin: raw.autoCheckin !== false,
  };
}

export function normalizeSlots(list) {
  const out = [];
  const seenPort = new Set();
  const seenProvider = new Set();
  for (const [i, raw] of (Array.isArray(list) ? list : []).entries()) {
    const slot = normalizeSlot(raw, i);
    if (!slot) continue;
    if (seenPort.has(slot.port) || seenProvider.has(slot.provider)) continue;
    seenPort.add(slot.port);
    seenProvider.add(slot.provider);
    out.push(slot);
  }
  return out.sort((a, b) => a.order - b.order || a.port - b.port);
}

/**
 * 解析上游的本地时间戳。
 *
 * `/v1/quota` 的 `expiresAt` 是 `"2026-11-30 23:59:59"` 这种**不带时区**的
 * 本地时间串。直接丢给 `Date.parse` 在不同 Node/V8 版本上对「非 ISO 且带空格」
 * 的处理并不一致（有的当本地、有的当 UTC），差 8 小时足以把「今天到期」算成
 * 「明天到期」。这里显式按本地时区拼，不依赖引擎的宽容解析。
 */
export function parseLocalStamp(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
}

/** 到期提醒的分档阈值（天）。 */
const EXPIRY_CRITICAL_DAYS = 3;
const EXPIRY_WARN_DAYS = 7;
const EXPIRY_NOTICE_DAYS = 30;

/**
 * 积分包到期分析。
 *
 * 用户真正的亏损不是「包过期」，而是「包过期时里面还剩积分」。所以只统计
 * `remain > 0` 的包 —— 一个已经用空的包过期了不影响任何东西，报出来只会
 * 制造噪音。
 *
 * 上游把余额拆成多个包（体验版月包 / 拉新权益包 / 运营裂变包 / 长期包），
 * 每个包各自到期。`total` 是所有包之和，所以「快到期的那部分」往往远小于
 * `total`：面板必须把这两个数分开展示，否则用户会以为整份余额都要没了。
 *
 * @param {Array<{name?:string,remain?:number,size?:number,expiresAt?:string}>} packages
 * @param {number} now 便于测试注入
 */
export function analyzeExpiry(packages, now = Date.now()) {
  const list = Array.isArray(packages) ? packages : [];
  const soon = [];
  let atRisk = 0;
  for (const pkg of list) {
    const remain = Number(pkg?.remain);
    if (!Number.isFinite(remain) || remain <= 0) continue; // 空包过期无害
    const at = parseLocalStamp(pkg?.expiresAt);
    if (!Number.isFinite(at)) continue;                    // 没有到期时间 = 长期包
    const inDays = Math.floor((at - now) / 86_400_000);
    const entry = {
      name: String(pkg?.name || ''),
      remain,
      size: Number(pkg?.size) || 0,
      expiresAt: String(pkg?.expiresAt || ''),
      at,
      inDays,
      expired: at <= now,
    };
    if (entry.expired) continue; // 已过期的包，上游本来就不再计入 total
    if (inDays <= EXPIRY_NOTICE_DAYS) {
      atRisk += remain;
      soon.push(entry);
    }
  }
  soon.sort((a, b) => a.at - b.at);
  const head = soon[0] || null;
  const level = !head ? 'ok'
    : head.inDays < EXPIRY_CRITICAL_DAYS ? 'critical'
      : head.inDays <= EXPIRY_WARN_DAYS ? 'warn'
        : 'notice';
  return {
    nextAt: head ? head.expiresAt : '',
    nextInDays: head ? head.inDays : null,
    nextRemain: head ? head.remain : 0,
    atRisk,
    level,
    soon: soon.slice(0, 8),
  };
}

/**
 * 自动切号：给一个账号打分，分高的优先消耗。
 *
 * 两种模式共用一条通道，差别只在排序键：
 *   - `expiry`（默认）到期优先：把「最早到期的那部分钱」当成紧迫度。
 *     关键细节 —— 不能只看 `total`。举例：A 号 total 5000，但其中 4900 分
 *     是年度包、一年后才过期；B 号 total 2400，其中 2400 分 13 天后就清零。
 *     先烧 total 大的会把 A 号选走，B 号那 2400 分就白扔了。所以排序用
 *     `atRisk`（30 天内会过期的钱）而不是 total。
 *   - `balance` 余额优先：谁钱多用谁，简单直观，但救不了快过期的部分。
 *
 * 打不动的号（没登录 / 桥没起 / 分不够）直接排除，不做「尽力而为」的尝试 ——
 * 切到一个没登录的号会让下一句话直接失败，比不切更糟。
 *
 * @returns {{ provider:string, score:number, urgency:number, days:number, remain:number }|null}
 */
export function rankSwitchCandidates(rows, { mode = SWITCH_DEFAULT_MODE, threshold = SWITCH_DEFAULT_THRESHOLD, exclude = '' } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of list) {
    if (!row) continue;
    const providerId = String(row.provider || '');
    if (!providerId || providerId === exclude) continue;
    if (row.needsLogin === true) continue;
    if (row.error) continue;
    const total = Number(row.total);
    if (!Number.isFinite(total) || total <= threshold) continue;
    const expiry = row.expiry || {};
    const atRisk = Number(expiry.atRisk) || 0;
    const days = Number.isFinite(Number(expiry.nextInDays)) ? Number(expiry.nextInDays) : 3650;
    let score;
    if (mode === 'balance') {
      score = total;
    } else {
      /*
       * 到期优先的打分：
       *   1. 先把「快过期且还有钱」的号顶上来（atRisk 权重最高）；
       *   2. 同样有钱快过期时，天数更少的更紧迫（分母 1+days，days=1 时
       *      权重翻倍，days=30 时几乎减半）；
       *   3. 再拿 total 做次级排序，避免多个号同分时顺序随机。
       * atRisk 为 0（全是长期包）的号会被压到后面 —— 这正是我们要的：
       * 它们不着急烧。
       */
      const urgency = atRisk / (1 + Math.max(0, days) / 7);
      score = urgency * 1000 + total / 100;
    }
    out.push({ provider: providerId, label: String(row.label || row.nickname || providerId), score, urgency: atRisk, days, remain: total });
  }
  out.sort((a, b) => b.score - a.score || a.days - b.days);
  return out[0] || null;
}

/** 每个 slot 的落盘目录：`<root>/<name>`（桥日志、凭据、账号快照都在这）。 */
function slotDirs(root, name) {
  const dir = join(root, name);
  return {
    dir,
    dataDir: dir,
    credentialDir: join(dir, 'credentials'),
    logPath: join(dir, 'bridge.log'),
  };
}

/**
 * 号池管理器。
 *
 * @param {object} options
 * @param {string} options.file          pool.json 路径（'' = 号池关闭）
 * @param {string} options.root          slot 目录根（pool.json 里的 poolRoot，缺省 <home>/.workbuddy-pool）
 * @param {string} options.bridgeScript  桥脚本绝对路径
 * @param {string} options.nodePath      起桥用的 node（'' = process.execPath）
 * @param {string} options.loginRegion   设备码登录区域
 * @param {object} options.llm           ctx.llm
 * @param {(ref:string)=>Promise<string>} options.resolveToken
 * @param {(ref:string,value:string)=>Promise<void>} options.setToken
 * @param {(ref:object)=>Promise<string|null>} options.resolveImage
 * @param {{allow?:string[],deny?:string[]}} options.filter 模型过滤（与主适配器同口径）
 * @param {object} options.defaults      默认请求参数
 * @param {number} options.catalogTtlMs
 * @param {number} options.streamIdleTimeoutMs
 * @param {number} options.autoStartTimeoutMs
 * @param {(line:string,detail?:unknown)=>void} options.log
 * @param {() => number} [options.primaryPort]
 */
export function createPool(options) {
  const {
    file, root, bridgeScript, nodePath = '', loginRegion = 'cn', llm,
    resolveToken, setToken, resolveImage, filter, defaults,
    catalogTtlMs, streamIdleTimeoutMs, autoStartTimeoutMs = 30_000, log,
    /*
     * 主账号快照注入。
     *
     * 自动切号必须知道「当前这个号还剩多少」，而用户默认就停在主账号
     * （provider = `workbuddy`）上 —— 它不在 slots 里，pool 自己读不到它的
     * 积分。没有这个钩子，autoSwitchTick 永远走 `unknown-current` 分支，
     * 等于功能整体失效。宿主端已经有 snapshot()，这里只借一次。
     *
     * 传的是 async () => row|null，返回形状与 slotRow 一致（provider/total/
     * expiry/packages/needsLogin/error）。
     */
    readPrimary = null,
    /*
     * 活跃账号变更回调。
     *
     * 收到参数是新的槽位名（`''` = 回到主账号）。主适配器用它做两件事：
     * 把 `ensureReady` 指到新桥、把目录缓存作废（否则选择器还挂着上一个号
     * 的模型清单，用户会以为切失败了）。
     */
    onActiveChange = null,
  } = options;

  /** provider → 运行态（adapter + 桥管理器 + 注册句柄）。 */
  const runtime = new Map();
  /** tokenRef → {value, at}；只在内存里，永不外传。 */
  const tokenCache = new Map();
  let slots = [];
  let config = null;
  let disposed = false;

  /*
   * ── 活跃账号 ────────────────────────────────────────────────────────────
   *
   * 号池不再为每个槽位注册一条 provider 路由（那会让模型选择器里冒出
   * `workbuddy-b/c/d…` 一串分组，用户明确不要）。取而代之的是：所有槽位
   * 都**藏在**同一条 `workbuddy` 路由后面，由这里的 `activeName` 决定下一次
   * 请求走哪个桥。
   *
   * 为什么这样做的成本最低：`WorkBuddyAdapter` 只在构造时记一次 `client`
   * （adapter.mjs:688），之后每个请求 —— 对话（stream）和目录（#fetchCatalog）
   * —— 都经过 `await this.ensureReady()`（adapter.mjs:838 / 1220）。所以
   * 只要 `ensureReady` 返回「当前活跃槽位的 client」，换账号就完成了；
   * 宿主侧一行都不用改，也就不会在 dsh 升级时被打回原形。
   *
   * `activeName` 是**槽位名**（b/c/d…），不是 provider id —— 后者仍留在
   * slot 上当内部账号键用（积分行、令牌、签到、看门狗都靠它索引）。
   * `''` = 停在主账号（桌面端凭据那个桥）上。
   */
  let activeName = '';
  /** activeName 的持久化位置：pool.json 的 `active` 字段。 */
  const setActiveName = (name) => {
    const next = String(name || '').trim();
    if (next === activeName) return false;
    activeName = next;
    // 换了账号 → 目录必须作废，否则选择器还显示上一个号的模型清单
    try { onActiveChange?.(activeName); } catch { /* 回调是尽力而为 */ }
    return true;
  };

  const load = () => {
    if (!file) { slots = []; config = null; activeName = ''; return; }
    const read = readPoolFile(file, log);
    config = read.data;
    slots = normalizeSlots(read.data?.slots);
    /*
     * 读回上次的活跃账号。只认「槽位名且该槽位确实存在」的值：手改过
     * pool.json、或删了槽位，都应当安静地退回主账号，而不是让第一次对话
     * 就报「桥不可用」。
     */
    const savedActive = String(read.data?.active || '').trim();
    activeName = savedActive && slots.some((s) => s.name === savedActive && s.enabled !== false)
      ? savedActive
      : '';
    if (!root) return;
    for (const slot of slots) {
      const dirs = slotDirs(root, slot.name);
      try { mkdirSync(dirs.credentialDir, { recursive: true }); } catch { /* 目录起不来时桥自己也会建 */ }
    }
  };

  const tokenOf = async (slot, { refresh = false } = {}) => {
    const hit = tokenCache.get(slot.tokenRef);
    if (!refresh && hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.value;
    let value = '';
    try {
      value = String((await resolveToken(slot.tokenRef)) || '');
    } catch (error) {
      log(`号池 token 解析失败：${slot.tokenRef}`, String(error?.message || error));
    }
    tokenCache.set(slot.tokenRef, { value, at: Date.now() });
    return value;
  };

  /**
   * 把当前活跃账号写回 pool.json（`active` 字段）。
   *
   * 为什么要持久化：重启 dsh 后桥还在跑，用户期望「还停在我上次选的号上」。
   * 只存槽位名（b/c/d）而不是 provider id —— 槽位被删掉时光看名字就能判断
   * 失效，`activeClient()` 会自动退回主账号。
   *
   * 失败不抛：写盘失败最多是「下次重启回到主账号」，不该让切号本身失败。
   */
  const persistActive = () => {
    if (!file) return;
    try {
      const data = { ...(config || {}), active: activeName };
      writePoolFile(file, data);
      config = data;
    } catch (error) {
      log('活跃账号写盘失败（本次仍生效，重启后会回到主账号）', String(error?.message || error));
    }
  };

  /**
   * 让模型选择器重取目录。
   *
   * 两个动作缺一不可：
   *   1. 通知主适配器作废缓存 —— 否则它还会返回上一个账号的模型清单；
   *   2. 发 `llm/adapters-updated` —— 选择器订阅这个事件才肯重拉；
   *      只作废缓存而不发事件，界面就一直显示旧列表。
   *
   * 槽位登录/登出、切号、删号都要走这里。
   */
  const invalidateCatalog = () => {
    try { onActiveChange?.(activeName); } catch { /* 尽力而为 */ }
    try { llm?.emitAdaptersUpdated?.(); } catch { /* 旧 dsh 没有这个通知 */ }
  };

  const ensureBridgeEnv = (slot) => {
    const dirs = slotDirs(root, slot.name);
    return {
      // 桥进程继承 dsh 的环境：把「主账号」相关的变量全部清掉，否则号池桥会去
      // 跟桌面端登录文件跑，等于两个桥共用一个钱包。
      WORKBUDDY_AUTH_FILE: '',
      WORKBUDDY_AUTH_FILE_FOLLOW: '',
      WORKBUDDY_AUTH_FOLLOW_UID: '',
      WORKBUDDY_CREDENTIAL_SOURCE: 'plugin',
      WORKBUDDY_CREDENTIAL_FAILOVER: 'off',
      WORKBUDDY_CREDENTIAL_DIR: dirs.credentialDir,
      WORKBUDDY_DATA_DIR: dirs.dataDir,
      WORKBUDDY_LOGIN_REGION: loginRegion,
      WORKBUDDY_AUTO_CHECKIN: slot.autoCheckin ? '1' : '0',
      WORKBUDDY_ACCOUNT_FAILOVER_AFTER: '0',
    };
  };

  /**
   * 建（或复用）一个 slot 的 client / supervisor。
   *
   * **不注册 provider 路由。** 槽位是「同一个 workbuddy 路由背后可切换的
   * 账号」，不是独立的模型分组 —— 注册了就会在模型选择器里多出一个分组。
   * 这里只负责让桥活着、令牌对得上，并把 client 挂到 runtime 上等
   * `activeClient()` 取用。
   *
   * 也不再建 `WorkBuddyAdapter`：adapter 由主账号那一个统一持有，目录/对话
   * 都经 `ensureReady` 解析到当前活跃 client（见 index.js 的注入）。
   */
  const ensureSlot = async (slot) => {
    const existing = runtime.get(slot.provider);
    if (existing) return existing;
    const dirs = slotDirs(root, slot.name);
    const token = await tokenOf(slot);
    const client = new BridgeClient({ baseUrl: `http://127.0.0.1:${slot.port}`, token, timeoutMs: 8000 });
    let supervisor = null;
    if (bridgeScript && existsSync(bridgeScript)) {
      supervisor = new BridgeSupervisor({
        projectRoot: dirs.dir,
        scriptPath: bridgeScript,
        logPath: dirs.logPath,
        host: '127.0.0.1',
        port: slot.port,
        token,
        nodePath: nodePath || process.execPath,
        autoStart: true,
        autoCheckin: slot.autoCheckin,
        timeoutMs: 8000,
        env: ensureBridgeEnv(slot),
        onLog: (line) => log(`[${slot.name}] ${line}`),
      });
    }
    /**
     * entry 里保留 `adapter: null` 与 `handle: null` 两个字段：面板和看门狗
     * 的历史代码用可选链读它们（`entry.adapter?.invalidate?.()`），留着比
     * 到处改成 `?.` 更安全，也让外部调用方不用逐个排查。
     */
    const entry = { slot, client, supervisor, adapter: null, handle: null, error: '' };
    runtime.set(slot.provider, entry);
    return entry;
  };

  const dropSlot = async (provider) => {
    const entry = runtime.get(provider);
    if (!entry) return;
    runtime.delete(provider);
    try { entry.handle?.(); } catch { /* 已经注销 */ }
    try { entry.adapter?.invalidate?.(); } catch { /* 忽略 */ }
    /*
     * 被删掉的正是当前活跃账号 → 退回主账号。否则下一次对话会拿一个已经
     * 不存在的 entry 去解析 client，用户看到的是「桥不可用」而不是「号没了」。
     */
    if (entry.slot?.name && entry.slot.name === activeName) setActiveName('');
  };

  /**
   * 当前活跃账号的桥 client；停在主账号时返回 `null`。
   *
   * 主适配器的 `ensureReady` 靠这个函数换账号 —— 返回 null 表示「用你自己
   * 那条到 8790 的 client」，也就是用户说的「默认就是主账号」。
   *
   * 为什么在这里做自愈而不是在 adapter 里：槽位的 supervisor、令牌、healSlot
   * 全在 pool 这侧，adapter 拿到的是个裸 client，它没有能力重启桥。
   */
  const activeClient = async () => {
    if (!activeName) return null;
    const slot = slots.find((s) => s.name === activeName);
    if (!slot) {
      // pool.json 被改过、或槽位被删：静默退回主账号，不要让对话直接失败。
      log(`活跃账号 ${activeName} 已不存在，退回主账号`);
      setActiveName('');
      return null;
    }
    let entry;
    try {
      entry = await ensureSlot(slot);
    } catch (error) {
      throw new Error(`号池 ${slot.label}：${String(error?.message || error)}`);
    }
    const supervisor = entry.supervisor;
    if (!supervisor) throw new Error(`号池 ${slot.name}：没有可用的桥脚本，无法自动拉起`);
    let result = await supervisor.ensure({ readyTimeoutMs: autoStartTimeoutMs });
    /*
     * `ensure()` 在「桥活着但没登录」时也返回 ok:false（state 是
     * unauthenticated/degraded）—— 那是用户该去扫码，**绝不要**因为 ok:false
     * 就重启桥。只有 unauthorized/foreign 才是令牌漂移，才值得自愈。
     */
    if (result.state === 'unauthorized' || result.state === 'foreign') {
      const healed = await healSlot(slot, entry);
      if (healed?.ok) result = await supervisor.ensure({ readyTimeoutMs: autoStartTimeoutMs });
    }
    if (!result.ok) {
      // 「没登录」是最常见的 ok:false —— 别把桥的原始英文健康体直接甩给用户
      if (result.state === 'unauthenticated' || result.state === 'degraded') {
        throw new Error(`号池 ${slot.label} 还没登录：在积分下拉菜单里点这一行的「登录」，扫码后再试。`);
      }
      throw new Error(result.error || `号池 ${slot.name} 的桥不可用`);
    }
    return entry.client;
  };

  /**
   * 把一个桥的**所有权**抓到当前进程上来。
   *
   * 为什么不能只靠 `ensure({restart:true})`：`bridge.mjs` 的 `#ensure` 只在
   * `state === 'running'` 时才走 stop→start 分支；桥若停在 `unauthenticated`
   * （活着、但还没扫码登录 —— 号池槽位的默认状态），它会直接复用端口上那个
   * 进程。重启 dsh 之后，被复用的正是**上一棵树留下的桥**：旧树一被回收，
   * 桥就跟着消失，而新 dsh 从头到尾都以为它是好的。
   *
   * 所以这里按「先按端口杀干净，再自己 spawn」的顺序做，不看状态机脸色。
   */
  const adoptBridge = async (slot, entry) => {
    const supervisor = entry.supervisor;
    if (!supervisor) return { ok: false, error: '没有 supervisor' };
    let pid = pidOnPort(slot.port);
    if (pid) {
      // 端口上有东西：不管是哪棵树拉起的，先请它走
      try { process.kill(pid, 'SIGTERM'); } catch { /* 已经没了 */ }
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (!pidOnPort(slot.port)) break;
      }
      if (pidOnPort(slot.port)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ }
        await new Promise((r) => setTimeout(r, 400));
      }
      supervisor.spawnedPid = null;
    }
    return supervisor.ensure({ readyTimeoutMs: autoStartTimeoutMs });
  };

  /**
   * 把所有 slot 的路由装好，并保证每个桥真的在跑、且归当前进程所有。
   *
   * 启动时只装路由是不够的：`registerAdapter` 会在第一次列模型时才去 ensure 桥，
   * 于是「面板上一片灰」要等到有人点开下拉菜单才自愈。这里直接抓一次所有权，
   * 让桥在 dsh 起来的同时全部就位（失败不阻断插件，面板会如实标红）。
   */
  const ensureAll = async () => {
    load();
    if (disposed) return;
    for (const slot of slots) {
      if (!slot.enabled) continue;
      let entry;
      try { entry = await ensureSlot(slot); } catch (error) {
        log(`号池初始化失败：${slot.name}`, String(error?.message || error));
        continue;
      }
      /*
       * 「桥活着但没登录」会让 ensure() 回 ok:false —— 那是正常状态，不是错误；
       * 这里只负责把进程拉起来并接管所有权，登录与否由面板显示。
       */
      try {
        const result = await adoptBridge(slot, entry);
        if (result && result.ok !== true && result.state !== 'unauthenticated' && result.state !== 'degraded') {
          log(`号池 ${slot.name} 的桥未就绪`, String(result.error || result.state || ''));
        }
      } catch (error) {
        log(`号池 ${slot.name} 的桥启动失败`, String(error?.message || error));
      }
    }
    startWatchdog();
    startCheckinTimer();
    // 只在 pool.json 里显式开了 `autoSwitch.enabled` 时才起：默认不自动切。
    startSwitchTimer();
  };

  // ── 看门狗 ─────────────────────────────────────────────────────────────
  /*
   * 为什么必须有它：dsh 重启时，`ensureAll()` 探测到的可能是**上一棵进程树**留下
   * 的桥（端口还在监听 → 判定 running → 直接复用，不再 spawn）。等旧树被回收，
   * 四个桥一起消失，而新 dsh 从头到尾都以为它们好好的：模型的第一次请求才炸，
   * 面板却一直是绿的。桥必须由当前 dsh 进程持续看护，不能只在启动时握手一次。
   */
  const WATCH_INTERVAL_MS = 20_000;
  let watchTimer = null;
  let watchBusy = false;

  const watchOnce = async () => {
    if (disposed || watchBusy) return;
    watchBusy = true;
    try {
      for (const slot of slots) {
        if (disposed) return;
        if (!slot.enabled) continue;
        const entry = runtime.get(slot.provider);
        if (!entry?.supervisor) continue;
        let probe;
        try {
          probe = await entry.supervisor.probe();
        } catch (error) {
          probe = { state: 'stopped', error: String(error?.message || error) };
        }
        if (probe.state === 'running' || probe.state === 'unauthenticated' || probe.state === 'degraded') {
          continue; // 活着（含「活着但没登录」）就不动手
        }
        if (disposed) return;
        if (probe.state === 'unauthorized' || probe.state === 'foreign') {
          await healSlot(slot, entry).catch(() => null);
          continue;
        }
        // stopped / aborted：桥没了，重新拉起（不动令牌，沿用现行的）
        try {
          const result = await entry.supervisor.ensure({ readyTimeoutMs: autoStartTimeoutMs });
          log(`号池 ${slot.name}：桥掉线，已重新拉起`, result.ok ? 'ok' : String(result.error || result.state || ''));
        } catch (error) {
          log(`号池 ${slot.name}：拉桥失败`, String(error?.message || error));
        }
      }
    } finally {
      watchBusy = false;
    }
  };

  const startWatchdog = () => {
    if (watchTimer) return;
    watchTimer = setInterval(() => { void watchOnce(); }, WATCH_INTERVAL_MS);
    // 定时器不能把 dsh 拖着不退：它只是看护，不是任务
    if (typeof watchTimer.unref === 'function') watchTimer.unref();
  };

  const stopWatchdog = () => {
    if (!watchTimer) return;
    clearInterval(watchTimer);
    watchTimer = null;
  };

  /** 自愈冷却：同一槽位 30 秒内只尝试一次，避免 30 秒轮询变成重启风暴。 */
  const healAt = new Map();
  const healPending = new Map();
  const HEAL_COOLDOWN_MS = 30_000;

  /**
   * 令牌漂移自愈。
   *
   * 为什么会漂：桥的 `WORKBUDDY_LOCAL_TOKEN` 是**进程启动那一刻**的环境变量，
   * 而凭据库里的 ref 值是可以被重新铸造的（加账号、init-pool、手改）。两者一旦
   * 不一致，管理面所有请求都 401，面板上三个槽位全红 —— 而桥本身一点问题没有。
   *
   * 处置只有一条路：用**当前** ref 值重开桥。难点是 `supervisor.stop()` 在 401
   * 下拒绝动手（拿不到可信 pid），所以先按 supervisor 自己记的 spawnedPid 杀，
   * 再退到端口监听者（桥可能由 start-pool.ps1 拉起，不是本进程的）。
   */
  const pidOnPort = (port) => {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 4000 });
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`));
          if (m) return Number(m[1]) || 0;
        }
        return 0;
      }
      const out = execFileSync('sh', ['-c', `command -v lsof >/dev/null && lsof -tiTCP:${port} -sTCP:LISTEN || true`], { encoding: 'utf8', timeout: 4000 });
      return Number(String(out).trim().split(/\s+/)[0]) || 0;
    } catch { return 0; }
  };

  const healSlot = async (slot, entry) => {
    const key = slot.provider;
    if (healPending.has(key)) return healPending.get(key);
    const last = healAt.get(key) || 0;
    if (Date.now() - last < HEAL_COOLDOWN_MS) return { ok: false, skipped: true };
    healAt.set(key, Date.now());
    const task = (async () => {
      // 1) 取当前 ref 值（refresh 强制绕过 60 秒缓存）
      const token = await tokenOf(slot, { refresh: true });
      if (!TOKEN_PATTERN.test(token)) {
        log(`号池 ${slot.name}：令牌缺失，无法自愈`);
        return { ok: false, error: '令牌缺失' };
      }
      // 2) 杀掉持有端口的旧桥：先问 supervisor，再问端口
      const supervisor = entry.supervisor;
      let pid = Number(supervisor?.spawnedPid) || 0;
      if (!pid) pid = pidOnPort(slot.port);
      if (pid) {
        try { process.kill(pid, 'SIGTERM'); } catch { /* 已经没了 */ }
        const deadline = Date.now() + 6000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          if (!pidOnPort(slot.port)) break;
        }
        if (pidOnPort(slot.port)) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* 忽略 */ }
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      // 3) 三个持有令牌的对象全部换成新值，否则重开的桥还是不认
      entry.client.token = token;
      if (supervisor) {
        supervisor.token = token;
        if (supervisor.client) supervisor.client.token = token;
        supervisor.spawnedPid = null;
      }
      // 4) 重开
      if (!supervisor) {
        log(`号池 ${slot.name}：没有 supervisor，令牌已刷新但无法自动重开桥`);
        return { ok: false, error: '没有 supervisor' };
      }
      const result = await supervisor.ensure({ restart: true, readyTimeoutMs: autoStartTimeoutMs });
      log(`号池 ${slot.name}：令牌漂移已自愈`, result.ok ? 'ok' : String(result.error || ''));
      return { ok: result.ok === true, error: result.ok ? '' : String(result.error || '') };
    })().finally(() => healPending.delete(key));
    healPending.set(key, task);
    return task;
  };

  /**
   * 把桥的签到回执压成界面要的那几个字段。
   *
   * 桥对「已签到」回的是幂等成功（`already:true`、`credit:0`），对「这个网关没有
   * 签到活动」回的是 `noActivity:true`；两者都不是失败，选择器里要分别说清楚，
   * 否则用户会以为自己漏签了。
   */
  const summarizeCheckin = (result) => {
    const status = result?.status || null;
    return {
      active: status?.active === true,
      done: status?.todayCheckedIn === true || result?.already === true,
      credit: Number(status?.todayCredit) || Number(result?.credit) || 0,
      dailyCredit: Number(status?.dailyCredit) || 0,
      streakDays: Number(status?.streakDays) || Number(result?.streakDays) || 0,
      noActivity: result?.noActivity === true,
      at: Date.now(),
    };
  };

  /** 一个 slot 的账号 + 积分 + 签到状态。任何一步失败都只降级该行。 */
  const slotRow = async (slot, signal) => {
    const entry = runtime.get(slot.provider) || null;
    const dirs = slotDirs(root, slot.name);
    const row = {
      kind: 'slot',
      name: slot.name,
      label: slot.label,
      provider: slot.provider,
      port: slot.port,
      tokenRef: slot.tokenRef,
      tokenConfigured: TOKEN_PATTERN.test(String((await tokenOf(slot)) || '')),
      bridgeState: 'down',
      bridgePid: 0,
      needsLogin: true,
      uid: '',
      nickname: '',
      expired: false,
      expiresAt: '',
      total: null,
      unlimited: false,
      packages: [],
      expiry: null,
      checkin: null,
      autoCheckin: slot.autoCheckin === true,
      autoCheckinAt: 0,
      error: entry?.error || '',
      logPath: dirs.logPath,
    };
    if (!entry) {
      row.error = row.error || '号池槽位未初始化';
      return row;
    }
    const { client } = entry;
    try {
      const health = await client.health(signal);
      if (health && health.ok === true) {
        row.bridgeState = 'running';
        row.bridgePid = Number(health.pid) || 0;
        row.authSource = String(health.credential?.configured || '');
      }
    } catch (error) {
      /*
       * 桥的 `/health` 在**活者但没登录**时回 503（body 里带 pid / build /
       * credential），`BridgeClient.#json` 对非 2xx 一律抛错 —— 于是「桥好好
       * 跑着，只是还没扫码」会被误判成 down，面板上写「桥未运行」，用户去查
       * 进程才发现它在跑。这里按 body 判活：有 pid 就是活的。
       */
      const payload = error?.payload;
      const alive = error?.status === 503 && payload && typeof payload.pid === 'number';
      if (alive) {
        row.bridgeState = 'running';
        row.bridgePid = payload.pid;
        row.authSource = String(payload.credential?.configured || '');
      } else if (error?.status === 401) {
        /*
         * 401 = 我们的令牌和桥里的不一致（桥被更早的进程用旧令牌拉起，或 ref
         * 重新铸造过）。这不是「用户要处理」的状态，是插件自己该修的：用当前
         * ref 值重开桥，然后重新探一次。冷却 30 秒，失败就如实标红。
         */
        row.bridgeState = 'unauthorized';
        row.error = '令牌与桥进程不一致，正在按当前凭据重启桥…';
        const healed = await healSlot(slot, entry);
        if (healed?.ok) {
          try {
            const again = await entry.client.health(signal);
            if (again && again.ok === true) {
              row.bridgeState = 'running';
              row.bridgePid = Number(again.pid) || 0;
              row.authSource = String(again.credential?.configured || '');
              row.error = '';
            }
          } catch (retry) {
            const p = retry?.payload;
            if (retry?.status === 503 && p && typeof p.pid === 'number') {
              row.bridgeState = 'running';
              row.bridgePid = p.pid;
              row.authSource = String(p.credential?.configured || '');
              row.error = '';
            } else {
              row.error = String(retry?.message || retry).slice(0, 300);
              return row;
            }
          }
        } else {
          row.error = `令牌不一致且自动重启未成功：${healed?.error || (healed?.skipped ? '冷却中' : '未知原因')}`.slice(0, 300);
          return row;
        }
      } else {
        row.bridgeState = 'down';
        row.error = String(error?.message || error).slice(0, 300);
        return row;
      }
    }
    try {
      const identity = await client.accountIdentity(signal);
      const auth = identity?.auth || {};
      row.uid = String(auth.userId || '');
      row.nickname = String(auth.nickname || auth.userName || '');
      row.authSource = String(auth.source || row.authSource || '');
      row.expiresAt = String(auth.expiresAt || '');
      row.expired = row.expiresAt ? Date.parse(row.expiresAt) < Date.now() : false;
      row.needsLogin = !row.uid;
    } catch (error) {
      // /v1/identity 在「没登录」时是 503 —— 这是正常状态，不是故障。
      row.needsLogin = true;
      if (error?.status !== 503) row.error = String(error?.message || error).slice(0, 300);
    }
    /*
     * /v1/identity 的 nickname 来自登录接口，上游经常给空串；而
     * /v1/auth/credentials 读的是**已落盘的凭据**，那里存着登录时写入的真名。
     * 主账号走 desktop 源时该接口为空，再退一层用 /v1/checkin/accounts。
     * 这一步纯展示用途，失败静默降级，不影响桥与切换。
     */
    if (row.needsLogin === false && !row.nickname) {
      const pick = (list, key) => {
        const arr = Array.isArray(list) ? list : [];
        const hit = arr.find((c) => String(c?.uid || c?.userId || '') === String(row.uid || ''))
          || arr.find((c) => c?.active === true || c?.current === true)
          || arr[0];
        return String(hit?.[key] || '').trim();
      };
      let name = '';
      try {
        name = pick((await client.authCredentials(signal))?.credentials, 'nickname');
      } catch { /* 主账号 desktop 源下为空 */ }
      if (!name) {
        try {
          name = pick((await client.checkinAccounts({ signal }))?.accounts, 'nickname');
        } catch { /* 展示用途 */ }
      }
      if (name) {
        row.nickname = name;
        row.label = name;
      }
    } else if (row.nickname) {
      row.label = row.nickname;
    }
    if (row.needsLogin) return row;
    try {
      const quota = await client.quota(signal);
      row.total = typeof quota?.total === 'number' ? quota.total : null;
      row.unlimited = quota?.unlimited === true;
      row.packages = Array.isArray(quota?.packages) ? quota.packages : [];
      row.expiry = analyzeExpiry(row.packages);
      row.account = String(quota?.account || '');
      row.quotaAt = Date.now();
      if (quota?.ok === false) row.error = String(quota.error || '');
    } catch (error) {
      row.error = String(error?.message || error).slice(0, 300);
    }
    if (slot.autoCheckin || row.uid) {
      /*
       * 这里**只读状态**（GET），绝不领奖。
       *
       * 领奖要走 POST，而 POST 是有副作用的写操作：面板每 30 秒轮询一次
       * `/pool/accounts`，若在这里带 claim，就成了「每 30 秒往上游打一次
       * 签到请求」。真正的领奖统一由 `autoCheckinTick()`（定时器）和用户手
       * 点「签到」触发，两者都走 `checkin({claim:true})`。
       */
      try {
        const status = await client.checkin({ signal });
        row.checkin = summarizeCheckin(status);
        row.autoCheckinAt = checkinLastAt.get(slot.provider) || 0;
      } catch (error) {
        // 签到活动没开 = 正常，不冒充错误
        row.checkin = null;
      }
    }
    return row;
  };

  /**
   * 主账号（插件自己的桥）也当成一行：选择器里必须能「切回主账号」，
   * 否则切到号池之后就没有回头路了。
   */
  const primaryRow = async (primary, signal) => {
    const row = {
      kind: 'primary',
      name: primary.name,
      label: primary.label,
      provider: primary.provider,
      port: primary.port,
      tokenRef: '',
      tokenConfigured: true,
      bridgeState: primary.bridgeState || 'unknown',
      needsLogin: false,
      uid: primary.uid || '',
      nickname: primary.nickname || '',
      total: typeof primary.total === 'number' ? primary.total : null,
      unlimited: primary.unlimited === true,
      packages: primary.packages || [],
      expiry: analyzeExpiry(primary.packages || []),
      checkin: primary.checkin || null,
      autoCheckinAt: checkinLastAt.get(primary.provider) || 0,
      error: primary.error || '',
    };
    // 主账号也用真名：nickname 有就替换「主账号」这个占位标签。
    if (row.nickname) row.label = row.nickname;
    return row;
  };

  /*
   * ── 定时签到 ──────────────────────────────────────────────────────────
   *
   * 为什么必须在插件层再做一遍，而不是靠桥自带的定时器：
   *
   *   1. 桥的 `startAutoCheckinTimer()` 只签**该桥自己的活跃账号**。号池里
   *      每个号占一个桥，只有「当前被切过去的」那个桥在跑，其余桥的账号
   *      根本不会被签；
   *   2. 桥进程随 dsh 退出而退出 —— 电脑关机 / dsh 没开的那天，一次都不会签。
   *      「昨天忘了开 dsh」= 白丢 100×N 积分；
   *   3. 桥的定时器是「启动 20 秒后 + 每小时」，跨天判断用 `localDay()`，
   *      但进程重启会清空 `autoCheckinDoneDay`，反复重启就会反复打上游。
   *
   * 所以插件层持有自己的一份「今天签过没」账本（`checkinDay`），按
   * 每 30 分钟一跳、当天最多成功一次、失败按指数退避重试（上限 1 小时）。
   * 账本只放内存：进程重启后重新探测一次状态即可（GET 是幂等的），
   * 不会因为丢账本就重复领奖 —— 上游对「已签到」回幂等成功。
   */
  const CHECKIN_TICK_MS = 30 * 60 * 1000;
  /** 失败后的最短/最长重试间隔。 */
  const CHECKIN_RETRY_MIN_MS = 5 * 60 * 1000;
  const CHECKIN_RETRY_MAX_MS = 60 * 60 * 1000;
  /** provider → 当天已成功签到的本地日期（YYYY-MM-DD）。 */
  const checkinDay = new Map();
  /** provider → 上次尝试的时间戳（面板展示「刚刚自动签到」用）。 */
  const checkinLastAt = new Map();
  /** provider → {tries, nextAt}：失败退避。 */
  const checkinRetry = new Map();
  let checkinTimer = null;
  let checkinBusy = false;
  /** 最近的自动签到结果，给面板/日志用。 */
  let checkinLastRun = null;

  /**
   * 批量设备码登录队列：provider → 队列项。
   *
   * 只存内存（设备码上游自己会过期，写盘没意义）。用途是让面板在
   * 「批量加完 → 刷新页面 → 回来授权」这条路径上还能看到码。
   */
  const loginQueue = new Map();
  const QUEUE_KEEP_DONE_MS = 10 * 60 * 1000;

  /** 淘汰已经过期的队列项，返回快照（按创建时间升序）。 */
  const queueSnapshot = () => {
    const now = Date.now();
    const out = [];
    for (const [provider, item] of loginQueue) {
      const age = now - Number(item.at || 0);
      // 成功的项留一段时间做反馈；失败的/过期的直接清
      const ttl = item.done ? QUEUE_KEEP_DONE_MS : (Number(item.login?.expiresIn) || 600) * 1000;
      if (age > ttl) { loginQueue.delete(provider); continue; }
      out.push({ ...item });
    }
    return out.sort((a, b) => Number(a.at) - Number(b.at));
  };
  const queueSet = (provider, item) => {
    if (!provider) return;
    loginQueue.set(provider, item);
  };

  const localDay = (ms) => {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /**
   * 给一个 provider 领今日签到。
   *
   * 返回 `{state}`：`claimed` 真领到了 / `already` 今天本来签过 /
   * `noActivity` 这个网关没有签到活动 / `error` 真失败。
   */
  const checkinOne = async (provider, entry) => {
    try {
      const result = await entry.client.checkin({ claim: true });
      const summary = summarizeCheckin(result);
      checkinLastAt.set(provider, Date.now());
      if (summary.noActivity) return { state: 'noActivity', summary };
      // already 也算今天的任务完成了，别再打上游
      return { state: summary.done ? 'claimed' : 'pending', summary, result };
    } catch (error) {
      const msg = String(error?.message || error);
      // 上游「没有签到活动」不是失败，不要进退避
      if (/no.?activity|not.?support|签到活动.*(未开启|未开放|已过期|已结束|不存在)/i.test(msg)) {
        checkinLastAt.set(provider, Date.now());
        return { state: 'noActivity', error: msg };
      }
      return { state: 'error', error: msg };
    }
  };

  /**
   * 一跳：把「今天还没签成功」的 slot 全签一遍。
   *
   * 顺序执行而不是 `Promise.all`：一条签到会同时触发上游的状态刷新与积分重算，
   * 五个桥并发打过去容易被上游当成异常流量。签到不赶时间，串行几秒足够。
   */
  const autoCheckinTick = async ({ force = false } = {}) => {
    if (disposed || checkinBusy) return null;
    if (!file) return null; // 号池关闭
    checkinBusy = true;
    const today = localDay(Date.now());
    const results = [];
    try {
      for (const slot of slots) {
        if (disposed) break;
        if (!slot.enabled || !slot.autoCheckin) continue;
        if (!force && checkinDay.get(slot.provider) === today) continue;
        const retry = checkinRetry.get(slot.provider);
        if (!force && retry && retry.nextAt > Date.now()) {
          results.push({ provider: slot.provider, name: slot.name, state: 'backoff', nextAt: retry.nextAt });
          continue;
        }
        let entry = runtime.get(slot.provider);
        if (!entry) {
          // 桥没起来就先起来；起不来算失败，进退避
          try { entry = await ensureSlot(slot); } catch (error) {
            results.push({ provider: slot.provider, name: slot.name, state: 'error', error: String(error?.message || error) });
            continue;
          }
        }
        const outcome = await checkinOne(slot.provider, entry);
        results.push({ provider: slot.provider, name: slot.name, ...outcome });
        if (outcome.state === 'claimed') {
          checkinDay.set(slot.provider, today);
          checkinRetry.delete(slot.provider);
          const credit = Number(outcome.summary?.credit) || 0;
          if (credit > 0) log(`自动签到 ${slot.label || slot.name} +${credit}`);
          /*
           * 领完立刻让 adapter 的模型目录失效？不必 —— 积分不影响目录。
           * 但积分变了，面板下一次轮询自然读到新的 total。
           */
        } else if (outcome.state === 'noActivity') {
          // 该网关没有签到活动，今天不用再试
          checkinDay.set(slot.provider, today);
          checkinRetry.delete(slot.provider);
        } else if (outcome.state === 'error') {
          const prev = checkinRetry.get(slot.provider);
          const tries = (prev?.tries || 0) + 1;
          const delay = Math.min(CHECKIN_RETRY_MIN_MS * 2 ** (tries - 1), CHECKIN_RETRY_MAX_MS);
          checkinRetry.set(slot.provider, { tries, nextAt: Date.now() + delay });
          log(`自动签到失败 ${slot.label || slot.name}`, String(outcome.error || '').slice(0, 160));
        }
      }
    } finally {
      checkinBusy = false;
    }
    checkinLastRun = { at: Date.now(), today, ok: results.every((r) => r.state !== 'error'), results };
    return checkinLastRun;
  };

  const startCheckinTimer = () => {
    if (checkinTimer) return;
    /*
     * 首次跳延后 60 秒：`ensureAll()` 刚把 N 个桥拉起来，上游连接预热、
     * 目录抓取都堆在开机那一刻，此时插一条签到只会互相拖慢。
     * `.unref()` 让定时器不阻止进程退出。
     */
    const first = setTimeout(() => { void autoCheckinTick(); }, 60_000);
    first.unref?.();
    checkinTimer = setInterval(() => { void autoCheckinTick(); }, CHECKIN_TICK_MS);
    checkinTimer.unref?.();
  };

  const stopCheckinTimer = () => {
    if (checkinTimer) { clearInterval(checkinTimer); checkinTimer = null; }
  };

  // ── 自动切号（第 6 项） ────────────────────────────────────────────────
  /*
   * 设计前提，三条都不能绕过：
   *
   * 1. **绝不打断对话。** 切 provider 会让下一轮换一个上游钱包，正在跑的那轮
   *    则上下文断在半路。所以只有 `inflight === 0` 且静默超过 `SWITCH_IDLE_MS`
   *    才允许动作。这也是用户原话「没有对话切换」的实现方式。
   *
   * 2. **只在低于阈值时切。** 当前号还有钱就继续用它 —— 频繁切号会让会话历史
   *    散落在不同 provider 上，用户翻聊天记录都能看出割裂。
   *
   * 3. **切号是客户端行为。** dsh 没有服务端「当前 provider」的概念，选择存在
   *    `agentDefaultModel` 里，由选择器 UI 写入。服务端只能改默认值，改不动
   *    已经打开的会话。所以这里的 `switchNow()` 返回**决策**，真正的
   *    `select()` 由面板执行；自动定时器走 `saveSelection()` 改默认值，
   *    新会话自然落在新账号上。
   */
  let switchTimer = null;
  let switchBusy = false;
  let switchLastRun = null;
  let switchLastAt = 0;

  /** 自动切号配置（持久化在 pool.json 的 `autoSwitch` 段）。 */
  const switchConfig = () => {
    const raw = config?.autoSwitch && typeof config.autoSwitch === 'object' ? config.autoSwitch : {};
    const threshold = Number(raw.threshold);
    return {
      // 默认关闭：切号会改默认模型，属于「用户不点头就不该自己发生」的事。
      enabled: raw.enabled === true,
      threshold: Number.isFinite(threshold) && threshold >= 0 ? threshold : SWITCH_DEFAULT_THRESHOLD,
      mode: raw.mode === 'balance' ? 'balance' : SWITCH_DEFAULT_MODE,
    };
  };

  const saveSwitchConfig = async (patch) => {
    if (!file) throw new Error('号池未启用（poolFile 为空）');
    load();
    const current = switchConfig();
    const next = { ...current };
    if (patch && typeof patch === 'object') {
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
      if (Number.isFinite(Number(patch.threshold)) && Number(patch.threshold) >= 0) next.threshold = Number(patch.threshold);
      if (patch.mode === 'balance' || patch.mode === 'expiry') next.mode = patch.mode;
    }
    const data = { ...(config || {}), autoSwitch: next };
    writePoolFile(file, data);
    config = data;
    if (next.enabled) startSwitchTimer(); else stopSwitchTimer();
    return next;
  };

  /**
   * 这个 provider 现在能不能被换走。
   *
   * 两道闸：adapter 的 `inflight`（有请求在飞）和 `lastActivityAt`
   * （刚回答完，用户可能马上追问）。取不到 adapter 时保守判定为「不能切」——
   * 宁可不动，也不要赌一把。
   *
   * 主账号（provider = `workbuddy`）不在 runtime 里，它的 adapter 归宿主端
   * 所有。所以这里允许调用方传一个 `row`：行上带 `idle:boolean` 就用它。
   * 少了这一步，默认停在主账号的用户永远被判 busy，自动切号等于没装。
   */
  const idleEnough = (provider, row = null) => {
    const adapter = runtime.get(provider)?.adapter;
    if (adapter) {
      if (adapter.inflight > 0) return false;
      const since = Date.now() - Number(adapter.lastActivityAt || 0);
      return since >= SWITCH_IDLE_MS;
    }
    if (row && typeof row.idle === 'boolean') return row.idle;
    return false;
  };

  /**
   * 收集「当前候选集」：号池槽位 + （按需）主账号一行。
   *
   * 为什么不复用 `accounts()`：那个方法是给面板画的，永远带上主账号（要起
   * 一次主账号 RPC 拿昵称/签到状态）。自动切号每一跳只需要一个数字，多打
   * 一趟上游没必要；但主账号**必须**在清单里 —— 用户默认就停在它上面。
   *
   * @param {{withPrimary?:boolean}} opts
   */
  const collectRows = async ({ withPrimary = true } = {}) => {
    const rows = await Promise.all(slots.map((slot) => slotRow(slot).catch((error) => ({
      kind: 'slot', name: slot.name, label: slot.label, provider: slot.provider,
      port: slot.port, bridgeState: 'down', needsLogin: true, error: String(error?.message || error),
    }))));
    if (withPrimary && typeof readPrimary === 'function') {
      try {
        const row = await readPrimary();
        // 主账号读不到时不要塞一个假行：宁可让它走 unknown-current，
        // 也不要用 total=null 去参与排序。
        if (row && row.provider) rows.push(row);
      } catch (error) {
        log('读取主账号快照失败（自动切号将只看号池）', String(error?.message || error));
      }
    }
    return rows;
  };

  /**
   * 一跳：看当前号够不够用，不够就挑一个最该烧的号，改默认选择。
   *
   * @param {{force?:boolean, current?:string}} opts
   *   `current` 由调用方（面板）传入 —— 服务端不知道用户此刻选的是哪个，
   *   只有面板知道。不传就按 `agentDefaultModel` 的当前值算。
   */
  const autoSwitchTick = async ({ force = false, current = '', applySwitch = false } = {}) => {    if (disposed || switchBusy || !file) return null;
    const cfg = switchConfig();
    if (!cfg.enabled && !force) return null;
    if (!force && Date.now() - switchLastAt < SWITCH_MIN_GAP_MS) return null;

    load();
    switchBusy = true;
    try {
      const list = await collectRows();
      /*
       * 「当前是哪个号」—— 两处调用要区分开：
       *
       *   - 面板手动点「立即切」：传进来的是它自己知道的当前账号；
       *   - 定时器：**没人传**。旧代码在这里直接 `skipped:'no-current'`
       *     返回，于是定时自动切号永远不会触发 —— 只有手动点才有效果。
       *     这不是设计，是漏了。
       *
       * 现在定时器也能自己判断：先看活跃槽位，没有就说明停在主账号，
       * 从 `readPrimary()` 取主账号的 provider。
       */
      let activeProvider = String(current || '').trim();
      if (!activeProvider) {
        const running = activeName ? slots.find((s) => s.name === activeName) : null;
        if (running) {
          activeProvider = running.provider;
        } else if (readPrimary) {
          try {
            const row = await readPrimary();
            activeProvider = String(row?.provider || '').trim();
          } catch { /* 主账号快照拿不到 → 下面按 no-current 处理 */ }
        }
      }
      if (!activeProvider) {
        return { at: Date.now(), skipped: 'no-current', detail: '调用方没有告知当前账号，无法判断该不该切' };
      }
      const me = list.find((r) => String(r?.provider || '') === activeProvider);
      if (!me) {
        return { at: Date.now(), skipped: 'unknown-current', detail: `当前账号 ${activeProvider} 不在清单里` };
      }

      /*
       * 当前号够用 → 什么都不做。这里的比较用 total 而不是 atRisk：
       * 「够不够用」看的是总额，不是快过期多少。
       */
      const mine = Number(me.total);
      if (Number.isFinite(mine) && mine >= cfg.threshold) {
        switchLastRun = { at: Date.now(), skipped: 'above-threshold', current: activeProvider, total: mine, threshold: cfg.threshold };
        switchLastAt = Date.now();
        return switchLastRun;
      }
      // 当前号自己就没登录 / 桥挂了 → 这也算「需要切」，继续往下走
      if (!force && !idleEnough(activeProvider, me)) {
        /*
         * 正在跑对话：本轮放弃，下一跳再看。**不排队、不延后补切** ——
         * 用户手动停下后可能继续追问，攒一个「等他停下就切」的待办会让
         * 下一句话莫名其妙换号。宁可永远不切。
         */
        switchLastRun = { at: Date.now(), skipped: 'busy', current: activeProvider, total: Number.isFinite(mine) ? mine : null };
        switchLastAt = Date.now();
        return switchLastRun;
      }

      const pick = rankSwitchCandidates(list, { mode: cfg.mode, threshold: cfg.threshold, exclude: activeProvider });
      if (!pick) {
        switchLastRun = { at: Date.now(), skipped: 'no-target', current: activeProvider };
        switchLastAt = Date.now();
        return switchLastRun;
      }

      switchLastRun = {
        at: Date.now(),
        switched: true,
        from: activeProvider,
        to: pick.provider,
        toLabel: pick.label,
        score: Math.round(pick.score),
        detail: `余额 ${Number.isFinite(mine) ? mine : '?'} < ${cfg.threshold}，切到 ${pick.label}（到期 ${pick.days} 天，风险额 ${pick.urgency}）`,
      };
      switchLastAt = Date.now();
      /*
       * 决策落地。
       *
       * 旧实现把这一步留给面板（它拿到 `to` 之后调 `select()` 换 provider）。
       * 单路由之后没有 provider 可换 —— 必须在池里把活跃指针挪过去，
       * 否则「自动切号」会变成一个只写日志的空操作，定时器尤其明显：
       * 它压根没有面板在旁边帮它执行。
       *
       * 只改指针、不重建任何东西：正在跑的那一轮持有旧 client 引用，会自然
       * 跑完；下一轮请求才用新账号。这正是用户要的「没有对话切换」。
       */
      if (applySwitch) {
        const slot = slots.find((s) => s.provider === pick.provider);
        if (slot) {
          setActiveName(slot.name);
          persistActive();
          invalidateCatalog();
          switchLastRun.applied = true;
        } else {
          // 目标是主账号（不在 slots 里）→ 退回主账号
          setActiveName('');
          persistActive();
          invalidateCatalog();
          switchLastRun.applied = true;
        }
        switchLastRun.active = { key: slots.find((s) => s.name === activeName)?.provider || '', name: activeName };
      }
      log(`自动切号：${activeProvider} → ${pick.label}`, switchLastRun.detail);
      return switchLastRun;
    } catch (error) {
      switchLastRun = { at: Date.now(), error: String(error?.message || error) };
      switchLastAt = Date.now();
      return switchLastRun;
    } finally {
      switchBusy = false;
    }
  };

  const startSwitchTimer = () => {
    if (switchTimer) return;
    const cfg = switchConfig();
    if (!cfg.enabled) return;
    /*
     * `applySwitch: true` 是定时器唯一有意义的取值 —— 定时器旁边没有面板
     * 帮它执行决策。不传就等于「每小时算一次该切到谁，然后什么也不做」。
     */
    const first = setTimeout(() => { void autoSwitchTick({ applySwitch: true }); }, 90_000);
    first.unref?.();
    switchTimer = setInterval(() => { void autoSwitchTick({ applySwitch: true }); }, SWITCH_TICK_MS);
    switchTimer.unref?.();
  };

  const stopSwitchTimer = () => {
    if (switchTimer) { clearInterval(switchTimer); switchTimer = null; }
  };

  /**
   * 加一个账号：分配端口 + 铸令牌 + 落 pool.json + 起桥 + 注册路由 + 起设备码。
   *
   * 提成局部函数是为了让 `add`（单个）和 `addBatch`（批量队列）走**同一条**
   * 实现：批量只是循环调用，任何一处修端口/令牌/落盘的逻辑都同时生效，
   * 不会出现"单个能加、批量加了起不来"的两套代码。
   */
  const addOne = async ({ label = '', port = 0, name = '', region = '' } = {}) => {
    if (!file) throw new Error('号池未启用（poolFile 为空）');
    load();
    const usedPorts = new Set(slots.map((s) => s.port));
    let nextPort = Number(port) || 0;
    if (!nextPort) {
      nextPort = 8791;
      while (usedPorts.has(nextPort)) nextPort += 1;
    }
    if (usedPorts.has(nextPort)) throw new Error(`端口 ${nextPort} 已被号池占用`);
    const usedNames = new Set(slots.map((s) => s.name));
    let nextName = String(name || '').trim().toLowerCase();
    if (!nextName) {
      const letters = 'bcdefghijklmnopqrstuvwxyz'.split('');
      nextName = letters.find((c) => !usedNames.has(c)) || `s${slots.length + 1}`;
    }
    const slot = normalizeSlot({ name: nextName, port: nextPort, label: label || `号池 ${nextName.toUpperCase()}` }, slots.length);
    if (!slot) throw new Error('槽位参数不合法（name/port）');
    const token = randomBytes(24).toString('base64url');
    await setToken(slot.tokenRef, token);
    tokenCache.set(slot.tokenRef, { value: token, at: Date.now() });
    config = config || {};
    const nextData = {
      ...config,
      poolRoot: config.poolRoot || root,
      slots: [
        ...(Array.isArray(config.slots) ? config.slots : []),
        { name: slot.name, port: slot.port, provider: slot.provider, tokenRef: slot.tokenRef, label: slot.label },
      ],
    };
    writePoolFile(file, nextData);
    config = nextData;
    load();
    const fresh = slots.find((s) => s.provider === slot.provider) || slot;
    const entry = await ensureSlot(fresh);
    let started = null;
    if (entry.supervisor) {
      started = await entry.supervisor.ensure({ readyTimeoutMs: autoStartTimeoutMs })
        .catch((error) => ({ ok: false, error: String(error?.message || error) }));
    }
    invalidateCatalog();
    log(`号池已添加：${fresh.name} :${fresh.port}`);
    let login = null;
    try {
      login = await entry.client.deviceLoginStart({ region: region || loginRegion });
    } catch (error) {
      login = { ok: false, error: String(error?.message || error) };
    }
    return {
      ok: true,
      slot: fresh,
      started: started || null,
      // 「加完马上就能扫码登录」：设备码直接带回去，省一次往返。
      login,
    };
  };

  return {
    get enabled() { return Boolean(file); },
    get file() { return file; },
    get root() { return root; },
    get slots() { return slots.map((s) => ({ ...s })); },
    get runtime() { return runtime; },
    reload: load,
    ensureAll,
    providerIds: () => [...runtime.keys()],
    /**
     * 当前活跃账号的桥 client（`null` = 主账号）。
     *
     * 主适配器的 `ensureReady` 直接用它：返回值非空就说明用户切到了号池里
     * 的某个号，这一轮请求要打那个桥；回 null 就走主账号自己那条。
     */
    activeClient,
    /**
     * 账号键 → 对外显示名。
     *
     * `provider` 仍然是内部账号键（`workbuddy-b`…），但界面上不该出现它 ——
     * 用户看到的是每个号自己的真实昵称（登录后由桥回填到 `slot.label`）。
     */
    labelOf(key = '') {
      const id = String(key || '').trim();
      if (!id) return '';
      const slot = slots.find((s) => s.provider === id);
      return slot ? slot.label : '';
    },
    /** 当前活跃账号：`{ key, name, label }`；停在主账号时 key 为空。 */
    get activeAccount() {
      if (!activeName) return { key: '', name: '', label: '' };
      const slot = slots.find((s) => s.name === activeName);
      if (!slot) return { key: '', name: '', label: '' };
      return { key: slot.provider, name: slot.name, label: slot.label };
    },
    /**
     * 切换活跃账号（`''` 或 'a' = 回主账号）。
     *
     * 立即生效、不重启、不动宿主：下一次请求就会用新桥。**不打断正在飞的
     * 对话** —— 已经在跑的那一轮拿的是旧 client 的引用，会自然跑完；切号
     * 只影响之后发起的请求。这正是用户要的「没有对话切换」。
     */
    async setActive(key = '') {
      if (!file) return { ok: false, error: '号池未启用' };
      load();
      const want = String(key || '').trim();
      if (!want || want === 'a') {
        setActiveName('');
        persistActive();
        return { ok: true, active: this.activeAccount || { key: '', name: '', label: '' } };
      }
      const slot = slots.find((s) => s.provider === want || s.name === want);
      if (!slot) return { ok: false, error: `没有这个账号：${want}` };
      if (!slot.enabled) return { ok: false, error: `账号 ${slot.label} 已停用` };
      setActiveName(slot.name);
      persistActive();
      // 顺手把桥拉起来：用户切过去就该能直接说话，不必先等一次失败再重试。
      void ensureSlot(slot).catch((error) => log(`切到 ${slot.label} 时起桥失败`, String(error?.message || error)));
      return { ok: true, active: this.activeAccount };
    },
    /**
     * 取某个 provider 已建好的 BridgeClient。
     *
     * 只回**已经在 runtime 里**的实例，绝不为了读一次数据去拉一个新桥：
     * 调用方（倍率面板）是只读场景，进程生命周期应当由 ensureAll /
     * 面板主流程决定，不该被一次 60 秒轮询触发。
     */
    clientFor(provider = '') {
      const key = String(provider || '').trim();
      if (!key) return null;
      return runtime.get(key)?.client || null;
    },
    /** 自动切号状态 + 配置（给面板/诊断用）。 */
    get switchState() {
      const cfg = switchConfig();
      return {
        ...cfg,
        running: Boolean(switchTimer),
        busy: switchBusy,
        lastRun: switchLastRun,
        lastAt: switchLastAt,
        idleMs: SWITCH_IDLE_MS,
        // 每个 provider 当前能不能被换走：面板据此决定「立即切」按钮是否可点
        idle: Object.fromEntries([...runtime.entries()].map(([p, e]) => [p, Boolean(e?.adapter && e.adapter.idleForSwitch)])),
      };
    },
    /** 写自动切号配置（面板的开关/阈值/模式）。 */
    setSwitchConfig: (patch) => saveSwitchConfig(patch),
    /** 手动跑一跳（`force` 忽略开关、阈值冷却与忙碌闸）。 */
    /**
     * 手动跑一跳并**落地**。
     *
     * `applySwitch: true` 与定时器同口径 —— 用户点「立即切」期望的是切过去，
     * 不是「给我看一下该切到谁」。旧实现让面板拿结果自己调 `select()`，
     * 单路由之后那条路没了，所以决策必须在这里执行。
     */
    switchNow: (opts) => autoSwitchTick({ force: true, applySwitch: true, ...(opts || {}) }),
    /** 只算不切：面板的预览用（不传 applySwitch 即为纯计算）。 */
    async switchPreview({ current = '' } = {}) {
      if (!file) return { ok: false, error: '号池未启用' };
      load();
      const cfg = switchConfig();
      /*
       * 这里直接拼 slotRow，不调 `this.accounts()`：对象字面量里的方法之间
       * 互调要经过 `this`，而 `this` 在解构调用（`const { switchPreview } = pool`）
       * 下会丢。用局部函数最稳，也省掉一次主账号快照（预览只要槽位）。
       */
      const list = await collectRows();
      const activeProvider = String(current || '').trim();
      const me = list.find((r) => String(r?.provider || '') === activeProvider) || null;
      const pick = rankSwitchCandidates(list, { mode: cfg.mode, threshold: cfg.threshold, exclude: activeProvider });
      return {
        ok: true,
        config: cfg,
        current: activeProvider,
        currentTotal: Number.isFinite(Number(me?.total)) ? Number(me.total) : null,
        belowThreshold: !me || !Number.isFinite(Number(me.total)) || Number(me.total) < cfg.threshold,
        target: pick,
        idle: idleEnough(activeProvider, me),
      };
    },
    /** 定时签到状态（给面板/诊断用）。 */
    get checkinState() {
      return {
        running: Boolean(checkinTimer),
        busy: checkinBusy,
        today: localDay(Date.now()),
        done: slots.filter((s) => checkinDay.get(s.provider) === localDay(Date.now())).map((s) => s.provider),
        pending: slots.filter((s) => s.autoCheckin && checkinDay.get(s.provider) !== localDay(Date.now())).map((s) => s.provider),
        retry: [...checkinRetry.entries()].map(([provider, v]) => ({ provider, ...v })),
        lastRun: checkinLastRun,
      };
    },
    /** 手动触发一次全量签到（忽略「今天已签」与退避）。 */
    autoCheckinNow: () => autoCheckinTick({ force: true }),
    /** 选择器要的完整清单：主账号 + 每个 slot。 */
    async accounts({ primary, signal } = {}) {
      load();
      const rows = [];
      if (primary) rows.push(await primaryRow(primary, signal));
      const slotRows = await Promise.all(slots.map((slot) => slotRow(slot, signal).catch((error) => ({
        kind: 'slot', name: slot.name, label: slot.label, provider: slot.provider,
        port: slot.port, bridgeState: 'down', needsLogin: true, error: String(error?.message || error),
      }))));
      rows.push(...slotRows);
      return {
        ok: true,
        at: Date.now(),
        slots: slots.length,
        accounts: rows,
      };
    },
    /** 手动签到：一个 slot 或全部。 */
    async checkin({ provider = '', signal } = {}) {
      const targets = provider
        ? slots.filter((slot) => slot.provider === provider)
        : slots;
      const results = [];
      for (const slot of targets) {
        const entry = runtime.get(slot.provider);
        if (!entry) { results.push({ provider: slot.provider, name: slot.name, ok: false, error: '槽位未初始化' }); continue; }
        try {
          const result = await entry.client.checkin({ claim: true, signal });
          /*
           * 手动签到也是「今天签过了」——必须写回账本，否则 30 秒后的自动
           * 一跳会再领一次。上游虽然是幂等的，但没必要打这一趟。
           */
          const summary = summarizeCheckin(result);
          checkinLastAt.set(slot.provider, Date.now());
          if (summary.done || summary.noActivity) {
            checkinDay.set(slot.provider, localDay(Date.now()));
            checkinRetry.delete(slot.provider);
          }
          results.push({
            name: slot.name,
            provider: slot.provider,
            label: slot.label,
            ok: result?.ok !== false,
            ...result,
            // 界面直接用这一份渲染徽标，不必再自己解释 already / noActivity
            summary,
          });
        } catch (error) {
          results.push({ name: slot.name, provider: slot.provider, label: slot.label, ok: false, error: String(error?.message || error) });
        }
      }
      return {
        ok: results.every((r) => r.ok !== false),
        claimed: results.filter((r) => r.ok !== false && r.already !== true).length,
        results,
      };
    },
    /** 设备码登录：让某个空槽位挂上一个号（= 「添加账号」的主路径）。 */
    async login({ provider = '', region = loginRegion } = {}) {
      const slot = slots.find((s) => s.provider === provider);
      if (!slot) throw new Error(`号池里没有 provider "${provider}"`);
      const entry = await ensureSlot(slot);
      const result = await entry.client.deviceLoginStart({ region });
      return { ok: true, provider: slot.provider, name: slot.name, label: slot.label, ...result };
    },
    async pollLogin({ provider = '', state = '' } = {}) {
      const slot = slots.find((s) => s.provider === provider);
      if (!slot) throw new Error(`号池里没有 provider "${provider}"`);
      const entry = runtime.get(slot.provider) || (await ensureSlot(slot));
      const result = await entry.client.deviceLoginPoll(state);
      /*
       * 队列状态跟着走：面板靠这个字段把「等待授权 / 刚成功 / 已失败」
       * 区分开，不必自己猜 result 的哪个字段代表什么。
       */
      const pending = loginQueue.get(slot.provider);
      if (pending) {
        const done = result?.done === true || result?.ok === true && result?.status === 'ok';
        const failed = result?.ok === false || result?.status === 'expired' || result?.status === 'denied';
        queueSet(slot.provider, {
          ...pending,
          done: done || pending.done === true,
          failed: failed || pending.failed === true,
          lastPoll: Date.now(),
          nickname: result?.nickname || result?.account?.nickname || pending.nickname || '',
          error: failed ? String(result?.error || result?.status || '授权失败') : (pending.error || ''),
        });
      }
      if (result?.ok !== false) {
        // 登录成功：桥内账号变了，目录/积分必须重取
        invalidateCatalog();
        tokenCache.delete(slot.tokenRef);
      }
      return { ok: true, provider: slot.provider, name: slot.name, ...result };
    },
    async logout({ provider = '' } = {}) {
      const slot = slots.find((s) => s.provider === provider);
      if (!slot) throw new Error(`号池里没有 provider "${provider}"`);
      const entry = runtime.get(slot.provider);
      if (!entry) throw new Error(`号池 ${slot.name} 未初始化`);
      const list = await entry.client.authCredentials();
      const active = String(list?.activeUid || '');
      if (!active) return { ok: true, provider: slot.provider, removed: 0 };
      await entry.client.authLogout(active);
      invalidateCatalog();
      return { ok: true, provider: slot.provider, removed: 1, uid: active };
    },
    /**
     * 加一个账号：分配端口 + 铸一个令牌写进 credentials + 落 pool.json + 起桥 + 注册路由。
     * 全程不需要改 cordis.patch.yml，也不需要重启 dsh。
     */
    /**
     * 加一个账号：分配端口 + 铸一个令牌写进 credentials + 落 pool.json + 起桥 + 注册路由。
     * 全程不需要改 cordis.patch.yml，也不需要重启 dsh。
     */
    async add(options = {}) {
      return addOne(options);
    },
    /**
     * 批量加账号（一次点出 N 个设备码）。
     *
     * 为什么一次能加多个：每个槽位是**独立桥进程 + 独立令牌**，互不影响，
     * 所以 N 个可以并行起桥；真正要串行的是「拿设备码」这一步 —— 同一账号
     * 上游对连续 device-code 请求有限流，而且用户也不可能一次授权 N 个。
     *
     * 串行 + 间隔：每个之间停 `BATCH_LOGIN_GAP_MS`。这不是为了好看，
     * 实测连续请求会有一条被上游 429 掉，反而更慢。
     *
     * 失败不中断：第 3 个失败不该让第 4、5 个也不加。失败项连同原因一起
     * 返回，成功的槽位保留（用户仍可以只授权成功的那几个）。
     */
    async addBatch({ count = 1, region = '' } = {}) {
      if (!file) throw new Error('号池未启用（poolFile 为空）');
      const total = Math.max(1, Math.min(MAX_BATCH_LOGIN, Math.trunc(Number(count) || 1)));
      const created = [];
      const failed = [];
      for (let i = 0; i < total; i += 1) {
        try {
          const result = await addOne({ region });
          const slot = result.slot;
          const login = result.login || {};
          const item = {
            provider: slot.provider,
            name: slot.name,
            label: slot.label,
            port: slot.port,
            login: {
              ok: login.ok !== false,
              state: login.state || '',
              /*
               * 桥给设备码的字段名是 `url`（单个 add 流程已经在用这个）。
               * 这里把常见别名一并收进来，面板只认 `verificationUri` 一个，
               * 以后桥换字段名也不会让链接消失。
               */
              userCode: login.userCode || login.user_code || '',
              verificationUri: login.url
                || login.verificationUri
                || login.verification_uri
                || login.verificationUriComplete
                || '',
              interval: Number(login.interval) || 0,
              expiresIn: Number(login.expiresIn ?? login.expires_in) || 0,
              error: login.ok === false ? String(login.error || '设备码获取失败') : '',
            },
            at: Date.now(),
          };
          created.push(item);
          queueSet(item.provider, item);
          log(`批量加号：${slot.label}（${created.length}/${total}）设备码=${item.login.userCode || '—'}`);
        } catch (error) {
          failed.push({ index: i, error: String(error?.message || error) });
          log(`批量加号失败（第 ${i + 1} 个）`, String(error?.message || error).slice(0, 160));
        }
        if (i < total - 1) await new Promise((r) => setTimeout(r, BATCH_LOGIN_GAP_MS));
      }
      return {
        ok: created.length > 0,
        requested: total,
        created,
        failed,
        // 队列快照：面板刷新后仍能拿到还没授权的设备码
        queue: queueSnapshot(),
      };
    },
    /**
     * 还没完成的设备码登录队列。
     *
     * 只存内存：设备码本身有上游有效期（通常 5–15 分钟），写盘没有意义，
     * 重启后用户重新点一次即可。completed 的项留一会儿再清，好让面板
     * 能显示"刚成功"的反馈。
     */
    get loginQueue() {
      return queueSnapshot();
    },
    /** 把一个已完成的队列项从队列里摘掉（成功或用户放弃）。 */
    dropQueued({ provider = '' } = {}) {
      const key = String(provider || '').trim();
      if (key && loginQueue.has(key)) {
        loginQueue.delete(key);
        return { ok: true, dropped: key };
      }
      return { ok: false, error: `队列里没有 "${key}"` };
    },
    async remove({ provider = '' } = {}) {
      const slot = slots.find((s) => s.provider === provider || s.name === provider);
      if (!slot) throw new Error(`号池里没有 "${provider}"`);
      // dropSlot 会把 runtime 里的 entry 删掉，先留一份句柄才能停桥
      const supervisor = runtime.get(slot.provider)?.supervisor || null;
      await dropSlot(slot.provider);
      load();
      if (config && Array.isArray(config.slots)) {
        const nextData = {
          ...config,
          slots: config.slots.filter((raw) => String(raw?.provider || `workbuddy-${raw?.name}`) !== slot.provider),
        };
        writePoolFile(file, nextData);
        config = nextData;
      }
      load();
      tokenCache.delete(slot.tokenRef);
      healAt.delete(slot.provider);
      const stopped = await supervisor?.stop().catch(() => null);
      invalidateCatalog();
      return { ok: true, removed: slot.provider, stopped };
    },
    async dispose() {
      disposed = true;
      stopWatchdog();
      stopCheckinTimer();
      stopSwitchTimer();
      for (const provider of [...runtime.keys()]) await dropSlot(provider);
    },
  };
}

/** 号池槽位目录根：pool.json 里的 poolRoot 优先，否则 <home>/.workbuddy-pool。 */
export function resolvePoolRoot(poolData, fallbackRoot) {
  const fromFile = String(poolData?.poolRoot || '').trim();
  if (fromFile) return fromFile;
  return fallbackRoot;
}

export { TOKEN_PATTERN };
