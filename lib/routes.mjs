/**
 * 面板的 HTTP 数据面 —— 客户端半边（lib/client.js）通过同源 fetch 调它。
 *
 * 为什么走 webServer 路由而不是 RPC/typert：客户端半边只要求「读状态 + 触发
 * 启停」，用普通 HTTP 路由最简单、最好调试，也不必为它维护一套严格反射定义。
 *
 * 安全边界：
 *   - 路由挂在 dsh 自己的 Web 载体上（只监听回环地址）；
 *   - **写操作**额外要求 `x-workbuddy-panel: 1` 头：这会让跨站表单/简单请求
 *     直接打不进来（带自定义头会触发 CORS 预检，而预检不会被放行），
 *     等于用最小代价挡掉 CSRF；读操作只暴露非敏感元数据。
 */
import { writeFileSync } from 'node:fs';

import { cleanLegacyRoutes, detectLegacyRoutes } from './legacy.mjs';
import { toDirectory } from './models.mjs';
import { analyzeExpiry } from './pool.mjs';
import { createConsoleApiHandler, CONSOLE_API_PREFIX } from './consoleApi.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

/** 校验"每模型默认参数"：只收认识且合法的字段，其余丢弃。 */
function sanitizeModelParams(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  if (typeof input.temperature === 'number' && Number.isFinite(input.temperature)
    && input.temperature >= 0 && input.temperature <= 2) out.temperature = input.temperature;
  if (Number.isInteger(input.maxTokens) && input.maxTokens > 0) out.maxTokens = input.maxTokens;
  if (typeof input.reasoningEffort === 'string' && input.reasoningEffort.trim()) out.reasoningEffort = input.reasoningEffort.trim();
  return Object.keys(out).length ? out : null;
}

/**
 * 上下文预算入参：0 / 空 = 清除覆盖（跟随官方默认），否则要求正整数。
 * 上下文的**上限收敛**仍由 adapter 按模型做（这里不拿目录值拒绝，
 * 否则和“先存意图、目录回来后自然生效”的既有语义冲突）。
 */
function readContextWindow(raw) {
  if (raw === null || raw === undefined || raw === '' || raw === 0 || raw === '0') return { value: 0 };
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000_000) {
    return { error: 'contextWindow 需要是正整数（tokens），或 0 表示跟随官方默认' };
  }
  return { value: n };
}

/**
 * @param {object} deps
 * @param {() => object} deps.snapshot 运行态快照
 * @param {() => object} deps.supervisor 桥管理器
 * @param {() => object} deps.consoleSupervisor 控制台管理器
 * @param {() => object} deps.client 桥客户端
 * @param {() => object} deps.adapter
 * @param {object} deps.paths { settingsPath, patchPath }
 * @param {string} deps.provider
 * @param {(line: string, detail?: unknown) => void} deps.log
 */
export function createRouteTable(deps) {
  const {
    snapshot, supervisor, consoleSupervisor, client, adapter, paths, provider, log,
    onUpstreamMutation = () => {}, onWritePrefs = () => {}, notifyAdaptersUpdated = () => false,
    enableWebSearch = async () => { throw new Error('web search configuration is unavailable'); },
    verifyWebSearch = async () => { throw new Error('web search verification is unavailable'); },
    revertWebSearch = async () => { throw new Error('web search restore is unavailable'); },
    pool = null,
  } = deps;

  /** 号池不可用时的统一答复（不是错误：号池本来就是可选的）。 */
  const noPool = (res) => sendJson(res, 200, { ok: false, pool: false, error: '号池未启用（poolFile 未配置）', accounts: [] });

  /**
   * 主账号那一行：把插件自己的 /workbuddy/quota 快照压成选择器要的形状。
   * 主账号不在号池里，但选择器必须能「切回主账号」，所以永远排第一。
   */
  const primaryAccount = (snap) => {
    const quota = snap?.quota && snap.quota.ok !== false ? snap.quota : null;
    const account = String(snap?.bridgeAccount || snap?.quotaAccount || '');
    const status = snap?.checkin?.status || null;
    return {
      kind: 'primary',
      name: 'a',
      label: '主账号',
      provider,
      port: supervisor?.port || 0,
      tokenRef: '',
      tokenConfigured: true,
      bridgeState: snap?.bridge?.state || '',
      bridgePid: Number(snap?.bridge?.health?.pid) || 0,
      needsLogin: snap?.bridge?.state === 'unauthenticated' || snap?.bridge?.state === 'degraded',
      uid: account,
      nickname: '',
      total: typeof quota?.total === 'number' ? quota.total : null,
      unlimited: quota?.unlimited === true,
      packages: Array.isArray(quota?.packages) ? quota.packages : [],
      /* 到期风险：只算 remain>0 的包，与号池槽位同一份口径 */
      expiry: analyzeExpiry(Array.isArray(quota?.packages) ? quota.packages : []),
      /* 自动签到的「今天签过没」由池管理器持有；主账号在这里只带最近一次时间 */
      autoCheckinAt: pool?.checkinState?.lastRun?.at || 0,
      /* 与号池槽位同一份口径，前端只写一套渲染逻辑 */
      checkin: status
        ? {
          active: status.active === true,
          done: status.todayCheckedIn === true,
          credit: Number(status.todayCredit) || 0,
          dailyCredit: Number(status.dailyCredit) || 0,
          streakDays: Number(status.streakDays) || 0,
          noActivity: false,
          at: snap?.checkin?.at || Date.now(),
        }
        : null,
      error: snap?.quotaError || '',
    };
  };

  /** 写操作的准入检查。 */
  const guard = (req) => req.headers['x-workbuddy-panel'] === '1';

  /**
   * 凭据/账号变了：目录属于旧账号，必须重取，并通知 dsh 的模型选择器。
   * dsh 不轮询目录，只认 `llm/adapters-updated`；只 invalidate 不通知的话，
   * 用户登录成功、模型其实已经可用，选择器里却还是旧清单（看起来像没登录）。
   */
  const refreshModelCatalog = () => {
    adapter.invalidate();
    const task = typeof adapter.warmup === 'function' ? adapter.warmup() : Promise.resolve();
    Promise.resolve(task).then(
      () => notifyAdaptersUpdated(),
      () => notifyAdaptersUpdated(),
    );
  };

  /**
   * 只读路由的方法守门：只允许 GET/HEAD。
   * 目前非 GET 走进去也只是"当成读"（没有副作用），但显式拒绝更严谨 ——
   * 免得将来有人在某个读分支里加写逻辑，而代理/表单又恰好能打到它。
   */
  const readOnly = (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') return false;
    sendJson(res, 405, { ok: false, error: `${req.method} not allowed on a read-only route` });
    return true;
  };

  return [
    {
      kind: 'exact',
      path: '/workbuddy/status',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          // ?quota=1：**强制**重读积分（平时 120 秒缓存；面板上的"刷新"按钮要立刻看到新值）
          const url = new URL(req.url, 'http://127.0.0.1');
          const forceQuota = url.searchParams.get('quota') === '1';
          sendJson(res, 200, { ok: true, ...(await snapshot({ quota: forceQuota })) });
        } catch (error) {
          log('panel status failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/identity',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const identity = await client.accountIdentity(AbortSignal.timeout(4000));
          sendJson(res, 200, { ok: true, ...identity });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/web-search/enable',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await enableWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search configure failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 只跑自检、不改配置：状态卡上的「重新检测」用它，避免为了看一眼结果
      // 重新写入 settings/credentials。真实搜索会消耗一次额度，因此仍要求面板头。
      kind: 'exact',
      path: '/workbuddy/web-search/verify',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await verifyWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search verify failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 恢复一键接入前的 dsh 搜索配置。只改 dsh settings/独立凭据引用，
      // 不碰 WorkBuddy 客户端文件；仍要求面板头，避免跨站触发配置回滚。
      kind: 'exact',
      path: '/workbuddy/web-search/revert',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await revertWebSearch();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          log('panel web-search restore failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 积分专用：GET 读缓存，POST 强制刷新（要面板头，避免跨站触发上游调用）
      kind: 'exact',
      path: '/workbuddy/quota',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const snap = await snapshot({ quota: true });
            return sendJson(res, 200, {
              ok: snap.quota?.ok !== false,
              quota: snap.quota,
              quotaError: snap.quotaError,
              at: snap.quotaAt,
              refreshed: true,
              /*
               * 桥状态随积分一起返回：桥掉登录态时 quota 可能还是上一个账号的
               * 缓存，光看 `ok/quotaError` 分辨不出来。客户端据此决定要不要
               * 把胶囊换成登录入口，不必再单独轮询 /workbuddy/status。
               */
              bridgeState: snap.bridge?.state || '',
              bridgeAccount: snap.bridgeAccount || null,
              quotaAccount: snap.quotaAccount || null,
            });
          }
          if (readOnly(req, res)) return;
          const snap = await snapshot({});
          sendJson(res, 200, {
            ok: snap.quota?.ok !== false,
            quota: snap.quota,
            quotaError: snap.quotaError,
            at: snap.quotaAt,
            bridgeState: snap.bridge?.state || '',
            bridgeAccount: snap.bridgeAccount || null,
            quotaAccount: snap.quotaAccount || null,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      // 插件登录状态：来源 + 凭据清单。桥是唯一事实来源；这里只做展示。
      // 响应里**永远不含** access / refresh token（桥侧已经保证，这里也不二次加工）。
      kind: 'exact',
      path: '/workbuddy/login',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const [source, creds] = await Promise.all([client.authSource(), client.authCredentials()]);
          sendJson(res, 200, {
            ok: true,
            ...source,
            configuredSource: creds.configuredSource,
            credentials: Array.isArray(creds.credentials) ? creds.credentials : [],
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error), credentials: [] });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/start',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const started = await client.deviceLoginStart({
            region: body?.region === 'global' ? 'global' : 'cn',
            open: body?.open === true,
          });
          sendJson(res, 200, { ok: true, ...started });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/poll',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.state) return sendJson(res, 400, { ok: false, error: 'state is required' });
          const result = await client.deviceLoginPoll(String(body.state));
          if (result?.status === 'ready') {
            // 账号换了：模型目录与余额/签到缓存都属于上一个账号
            refreshModelCatalog();
            onUpstreamMutation();
          }
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/cancel',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const result = await client.deviceLoginCancel(String(body?.state || ''));
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/active',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
          const result = await client.authSetActive(String(body.uid));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/logout',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          if (!body?.uid) return sendJson(res, 400, { ok: false, error: 'uid is required' });
          const result = await client.authLogout(String(body.uid));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/login/source',
      async handler(req, res) {
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const result = await client.setAuthSource(String(body?.source || 'auto'));
          refreshModelCatalog();
          onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/models',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const refresh = url.searchParams.get('refresh') === '1';
          const catalog = await adapter.catalog({ refresh });
          // 返回**归一化后**的目录（contextWindow/maxTokens/images/free…），
          // 不退上游原始字段名（context_window/max_output_tokens）：
          // 面板与其它消费者只认一种形状，免得两处各说一套。
          // contextWindow 是实际生效值（该模型的面板预算优先，按模型上限收敛）。
          sendJson(res, 200, {
            ok: true,
            models: toDirectory(catalog, {
              contextWindows: typeof adapter.contextWindowsSnapshot === 'function'
                ? adapter.contextWindowsSnapshot()
                : {},
            }),
            at: adapter.catalogCache.at,
            error: adapter.catalogError || '',
            // staleMs>0 = 这次强制刷新失败、退回旧缓存：面板要能如实说"你看到的是旧目录"
            refreshed: adapter.lastRefresh?.refresh === true,
            staleMs: Number(adapter.lastRefresh?.staleMs) || 0,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, models: [], error: String(error?.message || error) });
        }
      },
    },
    {
      /*
       * 倍率 + 错峰折扣面板的数据源。
       *
       * 只读、GET-only：面板打开时拉一次，之后每 60 秒刷一次（切换点是整点，
       * 1 分钟粒度足够）。**绝不**写任何状态，所以不带面板头也能读——
       * 与 /workbuddy/models 同一套宽松口径，方便调试时直接 curl。
       *
       * `?account=` 选看哪个账号的目录：不同账号的目录/促销可能不同
       * （例如只有部分账号拿到某些限时活动）。省略就用主账号。
       * 池槽位用 provider 名（workbuddy-b…），主账号用 workbuddy。
       */
      kind: 'exact',
      path: '/workbuddy/promotions',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const account = String(url.searchParams.get('account') || '').trim();
          const client = account && account !== 'workbuddy' && typeof pool?.clientFor === 'function'
            ? pool.clientFor(account)
            : adapter.client;
          if (!client) {
            sendJson(res, 200, { ok: false, error: `没有这个账号：${account}`, models: [] });
            return;
          }
          const data = await client.promotions();
          sendJson(res, 200, data);
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            models: [],
            error: String(error?.message || error),
          });
        }
      },
    },
    {
      // 模型显示偏好：GET 读当前生效清单，POST 写并即时生效（无需重启）。
      // 读：任何 GET 都行（非敏感）；写：要面板头（挡跨站，与其它写路由一致）。
      // 注意这里**没有**碰 .state.json —— 那份文件是控制台的单写者领地，
      // 偏好存在插件自己的 .model-prefs.json（见 index.js 里的说明）。
      kind: 'exact',
      path: '/workbuddy/model-visibility',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const current = (typeof deps.readPrefs === 'function' ? deps.readPrefs() : null)
              || { visible: null, hideAll: false, contextWindowByModel: {}, paramsByModel: {} };
            /*
             * 面板的「上下文窗口（Token）」表单：输入 + 输出一次提交。
             *
             * 必须排在两个单字段分支**前面**：旧实现的单字段分支各自只看一个
             * 字段，组合请求会落进 params 分支、把 contextWindow 静默吞掉。
             * 这里一次落盘、一次广播，避免“输入存了、输出没存”的半套状态。
             */
            if (typeof body?.model === 'string'
              && Object.prototype.hasOwnProperty.call(body, 'contextWindow')
              && Object.prototype.hasOwnProperty.call(body, 'params')) {
              const model = body.model;
              const parsed = readContextWindow(body.contextWindow);
              if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
              const cleaned = body.params === null ? null : sanitizeModelParams(body.params);
              /*
               * 输入/输出共享窗口只做建议，不在服务端硬拒绝：官方模型本身
               * 就可能给“默认输入 300K + 输出上限 384K”的组合。是否可用
               * 以上游实际限制为准，面板会提示但不阻断。
               */
              const contextWindowByModel = { ...(current.contextWindowByModel || {}) };
              if (parsed.value > 0) contextWindowByModel[model] = parsed.value;
              else delete contextWindowByModel[model];
              const paramsByModel = { ...(current.paramsByModel || {}) };
              if (cleaned) paramsByModel[model] = cleaned;
              else delete paramsByModel[model];
              // 先落盘再应用：写失败时不要留下“内存里已生效、重启后又变回去”的状态。
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial: current.includeUnofficial === true,
                contextWindowByModel,
                paramsByModel,
              });
              if (typeof adapter.setContextWindows === 'function') adapter.setContextWindows(contextWindowByModel);
              if (typeof adapter.setModelParams === 'function') adapter.setModelParams(paramsByModel);
              // 预算参与 dsh 的容量解析，参数参与 resolveModel；一次广播让两者都重算。
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, {
                ok: true,
                model,
                contextWindow: parsed.value,
                params: paramsByModel[model] || null,
                contextWindowByModel,
                paramsByModel,
                applied,
              });
            }
            /*
             * 每模型上下文预算：面板详情里每个模型有自己的输入/输出。
             * 它和"显示哪些模型"、每模型默认参数都正交；单字段分支保留给
             * 旧客户端 / 脚本，新面板走上面的组合分支。
             * `contextWindow: 0` = 清除该模型的覆盖，回到官方默认/桥目录值。
             */
            if (typeof body?.model === 'string'
              && Object.prototype.hasOwnProperty.call(body, 'contextWindow')
              && !Object.prototype.hasOwnProperty.call(body, 'params')) {
              const model = body.model;
              const parsed = readContextWindow(body.contextWindow);
              if (parsed.error) return sendJson(res, 400, { ok: false, error: parsed.error });
              const value = parsed.value;
              const contextWindowByModel = { ...(current.contextWindowByModel || {}) };
              if (value > 0) contextWindowByModel[model] = value;
              else delete contextWindowByModel[model];
              // 先落盘再应用：写失败时不要留下“内存里已生效、重启后又变回去”的状态。
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial: current.includeUnofficial === true,
                contextWindowByModel,
                paramsByModel: current.paramsByModel || {},
              });
              if (typeof adapter.setContextWindows === 'function') adapter.setContextWindows(contextWindowByModel);
              // 预算只影响元数据，不换目录，但仍要广播：dsh 用它重新解析
              // 每个模型的容量（token meter 的占用分母）。
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, { ok: true, model, contextWindow: value, contextWindowByModel, applied });
            }
            /*
             * 每模型默认参数：与"显示哪些"分开保存（同一份 prefs 文件的不同字段）。
             * `params: null` = 清除该模型的默认参数；其余字段做白名单校验。
             */
            if (typeof body?.model === 'string' && Object.prototype.hasOwnProperty.call(body, 'params')) {
              const model = body.model;
              const paramsByModel = { ...(current.paramsByModel || {}) };
              const cleaned = body.params === null ? null : sanitizeModelParams(body.params);
              if (cleaned) paramsByModel[model] = cleaned;
              else delete paramsByModel[model];
              // 先落盘再应用：写失败时不要留下“内存里已生效、重启后又变回去”的状态。
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial: current.includeUnofficial === true,
                contextWindowByModel: current.contextWindowByModel || {},
                paramsByModel,
              });
              if (typeof adapter.setModelParams === 'function') adapter.setModelParams(paramsByModel);
              return sendJson(res, 200, {
                ok: true, model, params: paramsByModel[model] || null, paramsByModel,
                contextWindowByModel: current.contextWindowByModel || {},
              });
            }
            /*
             * 「显示官方目录外的模型」：与 visible/hideAll 正交。
             * 官方列表（official=true）之外的老型号/未开通线路默认不进 dsh
             * 选择器；打开这个开关后按 visible 的规则一并显示。
             *
             * 只有**单独**提交这个开关时才走捷径。面板保存会同时带
             * `visible`/`unset`/`hideAll` —— 旧实现先命中这里就直接返回，
             * 把用户的勾选整批丢掉（实测：保存后面板读回空数组）。
             */
            const hasVisibilityIntent = Object.prototype.hasOwnProperty.call(body, 'visible')
              || Object.prototype.hasOwnProperty.call(body, 'unset')
              || Object.prototype.hasOwnProperty.call(body, 'hideAll');
            if (typeof body?.includeUnofficial === 'boolean' && !hasVisibilityIntent) {
              const includeUnofficial = body.includeUnofficial;
              adapter.setFilter({
                allow: current.visible === null ? undefined : (current.visible || []),
                hideAll: current.hideAll === true,
                includeUnofficial,
              });
              onWritePrefs({
                visible: current.visible,
                hideAll: current.hideAll === true,
                includeUnofficial,
                contextWindowByModel: current.contextWindowByModel || {},
                paramsByModel: current.paramsByModel || {},
              });
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, {
                ok: true, includeUnofficial,
                contextWindowByModel: current.contextWindowByModel || {},
                applied,
              });
            }
            /*
             * 三种显示意图，必须分开建模（旧实现只认 `visible` 数组）：
             *   - unset（恢复全部）：回到配置的 allow/deny（每模型参数保留）；
             *   - hideAll（全不选）：一个都不显示 —— `visible: []` 单独存在时
             *     不能当成"没设置"，否则 dsh 里反而全部还在；
             *   - 勾选清单：只显示这些。
             */
            const wantsUnset = body?.unset === true || body?.visible === null;
            const includeUnofficial = typeof body?.includeUnofficial === 'boolean'
              ? body.includeUnofficial
              : current.includeUnofficial === true;
            if (wantsUnset) {
              // 只重置"哪些模型显示"，不重置"是否包含官方目录外"
              adapter.resetFilter();
              adapter.setFilter({ includeUnofficial });
              onWritePrefs({
                visible: null,
                hideAll: false,
                includeUnofficial,
                contextWindowByModel: current.contextWindowByModel || {},
                paramsByModel: current.paramsByModel || {},
              });
              const applied = notifyAdaptersUpdated();
              return sendJson(res, 200, {
                ok: true, unset: true, visible: null, hideAll: false, includeUnofficial,
                contextWindowByModel: current.contextWindowByModel || {},
                count: 0, applied,
              });
            }
            /*
             * 空/截断的请求体不能落到「visible=[] → hideAll=true」：以前一次
             * 没带字段的 POST 就会把 dsh 选择器清空（还广播 adapters-updated），
             * 而接口自己回 200。这里要求明确的显示意图。
             */
            if (!hasVisibilityIntent) {
              return sendJson(res, 400, {
                ok: false,
                error: 'visible / unset / hideAll 至少需要一个（空请求不会改动显示偏好）',
              });
            }
            const visible = Array.isArray(body?.visible) ? body.visible.map(String).filter(Boolean) : [];
            const hideAll = body?.hideAll === true || visible.length === 0;
            // 目录里不存在的 id 也照存：上游目录可能暂时没抓到，用户勾选的意图优先，
            // 目录恢复后自然重新生效。
            adapter.setFilter({ allow: visible, hideAll, includeUnofficial });
            onWritePrefs({
              visible,
              hideAll,
              includeUnofficial,
              contextWindowByModel: current.contextWindowByModel || {},
              paramsByModel: current.paramsByModel || {},
            });
            // 广播 llm/adapters-updated：dsh 的模型选择器**不轮询**目录，只认这个
            // 事件。不广播的话 filter 虽已生效，但 UI 会一直显示旧清单。
            const applied = notifyAdaptersUpdated();
            return sendJson(res, 200, {
              ok: true,
              unset: false,
              visible,
              hideAll,
              includeUnofficial,
              contextWindowByModel: current.contextWindowByModel || {},
              count: hideAll ? 0 : visible.length,
              applied,
            });
          }
          if (readOnly(req, res)) return;
          const current2 = typeof deps.readPrefs === 'function' ? deps.readPrefs() : null;
          const filter = typeof adapter.filterSnapshot === 'function'
            ? adapter.filterSnapshot()
            : { allow: [], deny: [], hideAll: false };
          sendJson(res, 200, {
            ok: true,
            // `unset` 与 `visible: []` 是两种状态：前者=跟随配置（全显示），
            // 后者=用户点过"全不选"（全隐藏）。只有每模型参数、没有显示偏好时
            // visible 也是 null（显示跟随配置）。
            unset: !current2 || current2.visible === null,
            visible: current2 ? current2.visible : null,
            hideAll: current2 ? current2.hideAll === true : false,
            /** 是否把官方目录外的模型也放进 dsh 选择器 */
            includeUnofficial: current2 ? current2.includeUnofficial === true : false,
            /**
             * 每模型上下文预算（`{ [modelId]: tokens }`；缺条目 = 跟随官方默认）。
             * 实际生效值按各模型上限收敛，见 /workbuddy/models 的 contextWindow。
             */
            contextWindowByModel: typeof adapter.contextWindowsSnapshot === 'function'
              ? adapter.contextWindowsSnapshot()
              : (current2?.contextWindowByModel || {}),
            /** 每模型默认参数（面板详情里编辑） */
            paramsByModel: typeof adapter.modelParamsSnapshot === 'function'
              ? adapter.modelParamsSnapshot()
              : (current2?.paramsByModel || {}),
            /** 配置里 modelDeny 排除的模型：面板据此标出来，避免"勾了也不出现"的疑惑 */
            deny: filter.deny || [],
            at: adapter.catalogCache.at,
          });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/usage',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 账本由桥维护（内存副本 + 文件），必须让桥自己清 —— 与控制器同一条路径
            await client.clearUsage();
            return sendJson(res, 200, { ok: true, cleared: true });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 7, 1), 90);
          const hours = url.searchParams.get('hours') === '1';
          sendJson(res, 200, { ok: true, ...(await client.usage({ days, hours })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/requests',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          const url = new URL(req.url, 'http://127.0.0.1');
          const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 500);
          sendJson(res, 200, { ok: true, ...(await client.requests({ limit })) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/log',
      async handler(req, res) {
        try {
          if (req.method === 'DELETE') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            // 桥持有 bridge.log 的追加 fd：截断后它从新文件末尾继续（O_APPEND），与控制器一致
            try {
              writeFileSync(supervisor.logPath, '');
              return sendJson(res, 200, { ok: true, cleared: true });
            } catch (error) {
              return sendJson(res, 500, { ok: false, cleared: false, error: String(error?.message || error) });
            }
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const lines = Math.min(Math.max(Number(url.searchParams.get('lines')) || 200, 1), 2000);
          sendJson(res, 200, { ok: true, ...supervisor.readLog({ lines }) });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/checkin',
      async handler(req, res) {
        try {
          // GET = 读状态；POST?claim=1 = 领取（写，需要面板头）；其它方法拒绝
          if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST') {
            return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
          }
          const url = new URL(req.url, 'http://127.0.0.1');
          const claim = req.method === 'POST' && url.searchParams.get('claim') === '1';
          if (claim && !guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const result = await client.checkin({ claim });
          // 领取成功 = 上游余额变了：作废插件侧积分/签到缓存（下一次快照重取新值），
          // 否则面板最长 120 秒还显示领取前的余额
          if (claim && result?.ok !== false) onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/checkin/accounts',
      async handler(req, res) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { ok: false, error: `${req.method} not allowed` });
        }
        try {
          const result = await client.checkinAccounts();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/checkin/all',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        // 会往每个账号各发一次领取请求：必须带面板头，避免被同机页面顺手触发
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const result = await client.checkinAll();
          if (result?.ok !== false) onUpstreamMutation();
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/bridge',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          const body = await readJsonBody(req);
          const action = String(body?.action || 'status');
          if (action === 'start') {
            const result = await supervisor.ensure({});
            refreshModelCatalog();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'stop') {
            const result = await supervisor.stop();
            adapter.invalidate();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          if (action === 'restart') {
            const result = await supervisor.ensure({ restart: true });
            refreshModelCatalog();
            return sendJson(res, 200, { ok: result.ok, action, result });
          }
          const probe = await supervisor.probe();
          return sendJson(res, 200, { ok: true, action: 'status', result: probe });
        } catch (error) {
          log('panel bridge action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/console',
      async handler(req, res) {
        try {
          if (req.method !== 'POST') {
            if (readOnly(req, res)) return;
            const probe = await consoleSupervisor.probe({ cached: false });
            return sendJson(res, 200, { ok: true, url: consoleSupervisor.url, state: probe.state, error: probe.error || '', managed: consoleSupervisor.spawnedPid !== null });
          }
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const body = await readJsonBody(req);
          const action = String(body?.action || 'start');
          if (action === 'stop') {
            const result = await consoleSupervisor.stop();
            return sendJson(res, 200, { ok: result.ok, action, url: consoleSupervisor.url, result });
          }
          const result = await consoleSupervisor.ensure({});
          return sendJson(res, 200, { ok: result.ok, action: 'start', url: consoleSupervisor.url, result });
        } catch (error) {
          log('panel console action failed', error);
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/migrate',
      async handler(req, res) {
        try {
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const dryRun = body?.dryRun === true;
            const result = cleanLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider, dryRun });
            log(`legacy cleanup ${dryRun ? '(dry-run) ' : ''}changed=${result.changed}`);
            return sendJson(res, 200, { ok: true, ...result });
          }
          if (readOnly(req, res)) return;
          const detected = detectLegacyRoutes({ settingsPath: paths.settingsPath, patchPath: paths.patchPath, provider });
          sendJson(res, 200, { ok: true, ...detected });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /**
     * 号池账号清单 —— 积分胶囊下拉菜单的唯一数据源。
     *
     * 一行一个账号：主账号（插件自己的桥）+ 号池里每个桥。每行都带
     * 「还剩多少积分 / 今天签没签到 / 桥活没活 / 要不要登录」，前端只负责画。
     * 令牌永远不出现在这里（`tokenConfigured` 只报布尔）。
     */
    {
      kind: 'exact',
      path: '/workbuddy/pool/accounts',
      async handler(req, res) {
        if (readOnly(req, res)) return;
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const snap = await snapshot({});
          const primary = primaryAccount(snap);
          /*
           * 主账号也显示真名：/v1/identity 的 nickname 上游常给空串，
           * 而 /v1/auth/credentials 读的是登录时落盘的凭据，那里存着真名。
           * 纯展示用途，取不到就保留「主账号」。
           */
          if (!primary.nickname) {
            /*
             * 两条来源都试：
             *  - /v1/auth/credentials 读插件凭据（号池桥常用）；
             *  - /v1/checkin/accounts 读桌面登录文件（主账号走 desktop 源时只有这个有名字）。
             * 纯展示用途，都失败就保留「主账号」。
             */
            const pick = (list, key) => {
              const arr = Array.isArray(list) ? list : [];
              const hit = arr.find((c) => String(c?.uid || c?.userId || '') === String(primary.uid || ''))
                || arr.find((c) => c?.active === true || c?.current === true)
                || arr[0];
              return String(hit?.[key] || '').trim();
            };
            let name = '';
            try {
              const list = await client.authCredentials();
              name = pick(list?.credentials, 'nickname');
            } catch { /* 主账号 desktop 源下这个接口是空的 */ }
            if (!name) {
              try {
                const list = await client.checkinAccounts({});
                name = pick(list?.accounts, 'nickname');
              } catch { /* 展示用途 */ }
            }
            if (name) {
              primary.nickname = name;
              primary.label = name;
            }
          }
          const result = await pool.accounts({ primary });
          sendJson(res, 200, {
            ...result,
            pool: true,
            root: pool.root,
            file: pool.file,
            quotasAt: Date.now(),
            /*
             * 谁在扣额度。
             *
             * 单路由之后**不能**再用 `snapshot.current.provider` 判断了 ——
             * 选择器里永远是同一个 `workbuddy`，看不出背后是哪个号。
             * 真相在池管理器这里：`active.key` 是号池账号键，空串表示主账号。
             *
             * 面板据此打「当前」标记，自动切号也据此决定该不该切。
             */
            active: pool.activeAccount,
          });
        } catch (error) {
          sendJson(res, 200, { ok: false, pool: Boolean(pool?.enabled), accounts: [], error: String(error?.message || error) });
        }
      },
    },
    /**
     * 切换活跃账号。
     *
     * GET  → `{ active: {key,name,label} }`，只读，不需要面板头（方便 curl）。
     * POST → `{provider}`；`provider` 传空串或 `'a'`/主账号 id 表示回主账号。
     *
     * 为什么要这个端点：单路由之后，「切账号」不再等于「换 provider」，
     * 而是一个纯运行期状态。面板必须有一个地方表达这个动作 —— 否则
     * 用户点了某个号，界面上什么都没发生（选择器里根本没有别的分组可点）。
     *
     * 语义要点：**不打断正在跑的对话**。已经在飞的那一轮持有的是旧 client
     * 的引用，会自然跑完；这个端点只影响之后发起的请求。
     */
    {
      kind: 'exact',
      path: '/workbuddy/pool/active',
      async handler(req, res) {
        try {
          if (!pool || !pool.enabled) return noPool(res);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, active: pool.activeAccount });
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const body = await readJsonBody(req);
          const wanted = String(body?.provider ?? body?.key ?? '');
          const result = await pool.setActive(wanted);
          if (result?.ok !== true) return sendJson(res, 200, result);
          // 目录已换号 → 选择器要重拉（setActive 内部走 onActiveChange）
          notifyAdaptersUpdated?.();
          sendJson(res, 200, { ok: true, active: pool.activeAccount });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /** 手动签到：`?provider=` 只签一个，不带就签全部号池槽位。 */
    {
      kind: 'exact',
      path: '/workbuddy/pool/checkin',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const body = await readJsonBody(req);
          const wanted = String(body?.provider || '');
          const result = await pool.checkin({ provider: wanted, signal: AbortSignal.timeout(120_000) });
          if (result.ok) onUpstreamMutation();
          sendJson(res, 200, { ok: result.ok, ...result });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /**
     * 定时签到：GET 读状态，POST 立即跑一轮。
     *
     * 与 `/workbuddy/pool/checkin` 的分工：那条是「用户点了某一行的签到」，
     * 只签指定/全部槽位且不碰账本语义；这条是「定时任务本身」——POST 走的是
     * `autoCheckinNow({force:true})`，会忽略「今天已签」与失败退避，用来在
     * 用户明确要求时立刻补一轮（比如刚加完号、或跨天后想马上签）。
     */
    {
      kind: 'exact',
      path: '/workbuddy/pool/autocheckin',
      async handler(req, res) {
        try {
          if (!pool || !pool.enabled) return noPool(res);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...pool.checkinState });
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const result = await pool.autoCheckinNow();
          if (result?.ok) onUpstreamMutation();
          sendJson(res, 200, { ok: result?.ok !== false, ...result, state: pool.checkinState });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /**
     * 自动切号：读状态 / 写配置 / 立即切。
     *
     * 三种动作挤在一条路由上，是因为它们操作的是同一份状态，拼成一个面板
     * 请求比三条各自加锁简单：
     *   GET                    → 配置 + 每个 provider 是否空闲 + 上次决策
     *   POST {enabled,threshold,mode} → 写 pool.json 的 autoSwitch 段
     *   POST {action:'preview', current} → 只算不切，返回「该切到谁」
     *   POST {action:'now', current}   → 真跑一跳（force，忽略阈值冷却）
     *
     * `current` 必须由面板传：服务端不知道用户此刻选的是哪个 provider，
     * 只有前端的 `directory.store` 知道。
     */
    {
      kind: 'exact',
      path: '/workbuddy/pool/autoswitch',
      async handler(req, res) {
        try {
          if (!pool || !pool.enabled) return noPool(res);
          if (req.method === 'GET') {
            return sendJson(res, 200, { ok: true, ...pool.switchState });
          }
          if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'GET or POST only' });
          if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
          const body = await readJsonBody(req);
          const action = String(body?.action || '');
          const current = String(body?.current || '');

          if (action === 'preview') {
            const result = await pool.switchPreview({ current });
            return sendJson(res, 200, result);
          }
          if (action === 'now') {
            /*
             * `switchNow()` 自己会把决策落地（`applySwitch: true`）——
             * 单路由之后没有 provider 可换，活跃指针必须在池里挪。
             * 这里只在它报了 `switched` 却没落地时补一刀，防止版本错配
             * 导致「点了立即切，什么都没发生」。
             */
            const result = await pool.switchNow({ current });
            if (result?.switched && result.applied !== true && result.to) {
              await pool.setActive(result.to);
            }
            return sendJson(res, 200, {
              ok: result?.error ? false : true,
              result,
              active: pool.activeAccount,
              state: pool.switchState,
            });
          }
          // 其余情况 = 写配置
          const cfg = await pool.setSwitchConfig({
            enabled: typeof body?.enabled === 'boolean' ? body.enabled : undefined,
            threshold: body?.threshold,
            mode: body?.mode,
          });
          sendJson(res, 200, { ok: true, config: cfg, state: pool.switchState });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /** 添加账号：分配端口 + 铸令牌 + 起桥 + 注册 provider，返回设备码让用户直接扫码。 */
    {
      /*
       * 批量加号：一次点出 N 个设备码。
       *
       * POST {count, region} → 串行建槽位 + 起桥 + 起设备码，返回每一项的
       * 授权码/授权地址。GET → 只读队列快照（页面刷新后还能看到没授权的码）。
       *
       * 写操作要面板头（与其它写路由一致）；GET 不要，方便直接 curl 看队列。
       * 整个过程不需要重启 dsh：槽位是运行时注册的 provider。
       */
      kind: 'exact',
      path: '/workbuddy/pool/add-batch',
      async handler(req, res) {
        try {
          if (!pool || !pool.enabled) return noPool(res);
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const result = await pool.addBatch({
              count: Number(body?.count) || 1,
              region: String(body?.region || ''),
            });
            refreshModelCatalog();
            return sendJson(res, 200, result);
          }
          if (readOnly(req, res)) return;
          return sendJson(res, 200, { ok: true, queue: pool.loginQueue });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /** 把一个队列项摘掉（用户放弃授权 / 成功后清掉）。 */
    {
      kind: 'exact',
      path: '/workbuddy/pool/login-queue/drop',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const body = await readJsonBody(req);
          sendJson(res, 200, pool.dropQueued({ provider: String(body?.provider || '') }));
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    {
      kind: 'exact',
      path: '/workbuddy/pool/add',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const body = await readJsonBody(req);
          const result = await pool.add({ label: String(body?.label || ''), port: Number(body?.port) || 0, name: String(body?.name || '') });
          refreshModelCatalog();
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /** 移除账号：注销路由、停桥、从 pool.json 里删掉。 */
    {
      kind: 'exact',
      path: '/workbuddy/pool/remove',
      async handler(req, res) {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const body = await readJsonBody(req);
          const result = await pool.remove({ provider: String(body?.provider || '') });
          refreshModelCatalog();
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    /** 空槽位接一个号：POST 拿设备码，GET?state= 轮询结果。 */
    {
      kind: 'exact',
      path: '/workbuddy/pool/login',
      async handler(req, res) {
        try {
          if (!pool || !pool.enabled) return noPool(res);
          const url = new URL(req.url, 'http://127.0.0.1');
          const wanted = String(url.searchParams.get('provider') || '');
          if (req.method === 'POST') {
            if (!guard(req)) return sendJson(res, 403, { ok: false, error: 'missing x-workbuddy-panel header' });
            const body = await readJsonBody(req);
            const result = await pool.login({
              provider: String(body?.provider || wanted),
              region: String(body?.region || '') || undefined,
            });
            return sendJson(res, 200, result);
          }
          if (readOnly(req, res)) return;
          const state = String(url.searchParams.get('state') || '');
          if (!state) return sendJson(res, 400, { ok: false, error: 'state is required' });
          const result = await pool.pollLogin({ provider: wanted, state });
          if (result?.ok !== false) refreshModelCatalog();
          sendJson(res, 200, result);
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String(error?.message || error) });
        }
      },
    },
    // 控制台域的功能（账号 / 诊断 / 体检 / 对话测试 / 自动签到开关）原样透传，
    // 白名单见 consoleApi.mjs —— 单写者，两边状态才不会各说一套。
    {
      kind: 'prefix',
      path: CONSOLE_API_PREFIX,
      handler: createConsoleApiHandler({
        consoleSupervisor,
        log,
        onUpstreamMutation,
        onAccountSwitch: refreshModelCatalog,
      }),
    },
  ];
}

/**
 * 把路由表挂到 dsh 的 Web 载体上。
 * @param {object} target 要么是 webServer 服务本身，要么是一个能 `get('webServer')` 的 ctx
 * @returns {() => void} 幂等 disposer
 */
export function mountRoutes(target, routes, log = () => {}) {
  const webServer = typeof target?.register === 'function' ? target : target?.get?.('webServer');
  if (!webServer) {
    log('webServer 服务不可用，面板数据面未挂载（GUI 面板会显示离线）');
    return () => {};
  }
  const disposers = [];
  for (const route of routes) {
    try {
      disposers.push(webServer.register({ kind: route.kind, path: route.path, handler: route.handler }));
    } catch (error) {
      log(`挂载路由 ${route.path} 失败`, error);
    }
  }
  log(`已挂载 ${disposers.length}/${routes.length} 条面板路由`);
  return () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* 忽略 */ } } };
}
