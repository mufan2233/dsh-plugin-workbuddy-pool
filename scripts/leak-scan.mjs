#!/usr/bin/env node
/**
 * 发布前泄漏扫描 —— 打包/提交之前必须跑。
 *
 * 为什么需要它：`files` 白名单只限制到目录层级，vendor/ 整目录放行的代价是
 * 任何落在里面的运行期文件都会被发出去。1.22.x 就发生过 —— bridge.log 带着
 * 7 个账号 uid 和上游响应体被打进 tarball。
 *
 * 检查两件事：
 *   1. **不该存在的文件**：日志、凭证、号池配置、tgz；
 *   2. **不该出现的字符串**：UUID 形式的 uid、Windows 用户目录、本机昵称。
 *
 * 退出码：0 = 干净，1 = 发现问题（CI / npm prepublishOnly 可以直接卡住）。
 *
 *   node scripts/leak-scan.mjs            # 扫当前目录
 *   node scripts/leak-scan.mjs --json     # 机器可读
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes('--json');

/** 不该出现在分发包里的文件名 / 路径模式。 */
const FORBIDDEN_PATH = [
  { re: /\.log$/i, why: '运行期日志，含上游响应体与账号 uid' },
  { re: /\.log\.\d+$/i, why: '滚动日志' },
  { re: /\.jsonl$/i, why: '本地用量账本' },
  { re: /^\.state\.json$/i, why: '本机运行状态' },
  { re: /^\.env$/i, why: '使用者本地配置' },
  { re: /\.bak($|-)/i, why: '备份文件' },
  { re: /\.orig(-backup)?$/i, why: '补丁备份' },
  { re: /\.tgz$/i, why: '打包产物' },
  { re: /\.cred$/i, why: '账号凭证' },
  { re: /^workbuddy-pool\.json$/i, why: '号池配置（uid / 昵称 / 端口）' },
  { re: /^\.credentials\.yaml$/i, why: '凭证仓库' },
];

/**
 * 不该出现的字符串。
 *
 * 只看**内容**匹配，因此注释里写 "uid 1234abcd…" 也会被抓 —— 这是有意的：
 * 就算是作为"泄漏案例"引用，也不该进公开仓库。
 */
const FORBIDDEN_CONTENT = [
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, why: 'UUID 形式的账号 / 会话标识' },
  { re: /C:\\\\?Users\\\\?[A-Za-z0-9._-]+/i, why: 'Windows 绝对路径（带用户名）' },
  { re: /\/(?:home|Users)\/[a-z0-9._-]+\//i, why: 'Unix 绝对路径（带用户名）' },
  { re: /WORKBUDDY_POOL_[A-Z]_TOKEN\s*[:=]\s*\S{20,}/, why: '号池真实令牌' },
  { re: /Bearer\s+[A-Za-z0-9_-]{40,}/, why: '硬编码的 Bearer 令牌' },
];

/** 这些目录/文件不扫（依赖、产物体积大且非本仓库代码）。 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.pnpm-store']);
const SKIP_FILE = /^(package-lock\.json|\.npmignore|\.gitignore|leak-scan\.mjs)$/i;

/** 只扫文本类文件。 */
const TEXT_EXT = /\.(mjs|js|cjs|ts|json|md|yml|yaml|txt|html|css|sh|cmd|ps1)$/i;

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      walk(abs, out);
    } else {
      out.push({ abs, rel: relative(ROOT, abs), size: stat.size });
    }
  }
  return out;
}

const problems = [];
const files = walk(ROOT);

for (const file of files) {
  const base = file.rel.split(sep).pop();

  // 1) 文件级
  for (const rule of FORBIDDEN_PATH) {
    if (rule.re.test(base)) {
      problems.push({ kind: 'file', path: file.rel, why: rule.why, size: file.size });
      break;
    }
  }

  // 2) 内容级
  if (!TEXT_EXT.test(base) || SKIP_FILE.test(base)) continue;
  if (file.size > 8 * 1024 * 1024) continue;

  let text;
  try {
    text = readFileSync(file.abs, 'utf8');
  } catch {
    continue;
  }

  // 本文件自己含有规则字面量，跳过自检
  if (file.rel.endsWith('leak-scan.mjs')) continue;

  for (const rule of FORBIDDEN_CONTENT) {
    const match = rule.re.exec(text);
    if (!match) continue;
    // 报出所在行号，方便定位
    const line = text.slice(0, match.index).split('\n').length;
    problems.push({
      kind: 'content',
      path: file.rel,
      line,
      why: rule.why,
      sample: match[0].slice(0, 12) + '…',
    });
  }
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ root: ROOT, scanned: files.length, problems }, null, 2) + '\n');
} else {
  const fileIssue = problems.filter((p) => p.kind === 'file');
  const contentIssue = problems.filter((p) => p.kind === 'content');

  console.log(`\n泄漏扫描  ${ROOT}`);
  console.log('─'.repeat(64));
  console.log(`扫描 ${files.length} 个文件`);

  if (!problems.length) {
    console.log('\n✅ 干净：没有不该发布的文件，也没有账号标识残留。\n');
    process.exit(0);
  }

  if (fileIssue.length) {
    console.log(`\n❌ 不该打包的文件（${fileIssue.length}）：`);
    for (const p of fileIssue) {
      console.log(`   · ${p.path}  (${Math.round(p.size / 1024)} KB)`);
      console.log(`     原因：${p.why}`);
    }
  }

  if (contentIssue.length) {
    console.log(`\n❌ 内容里带账号标识（${contentIssue.length}）：`);
    for (const p of contentIssue) {
      console.log(`   · ${p.path}:${p.line}  ${p.sample}`);
      console.log(`     原因：${p.why}`);
    }
  }

  console.log(`\n共 ${problems.length} 处问题，先修掉再发布。\n`);
  process.exit(1);
}
