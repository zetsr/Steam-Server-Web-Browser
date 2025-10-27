'use strict';

const express = require('express');
const fetch = require('node-fetch').default;
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const WebSocket = require('ws');
const Query = require('source-server-query');

const app = express();

// 配置和参数解析部分保持不变...
function parseArgs() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (!token.startsWith('--')) continue;
    token = token.slice(2);
    let key, val;
    if (token.includes('=')) {
      [key, val] = token.split('=');
    } else {
      key = token;
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        val = next;
        i++;
      } else {
        val = 'true';
      }
    }
    const normalized = key.replace(/-/g, '_').toLowerCase();
    args[normalized] = val;
  }
  return args;
}

function toInt(val, fallback) {
  if (val === undefined || val === null) return fallback;
  if (typeof val === 'number') return Number.isFinite(val) ? Math.floor(val) : fallback;
  const n = parseInt(String(val).trim(), 10);
  return Number.isNaN(n) ? fallback : n;
}

function parseIntervalToMs(val, fallbackMs) {
  if (val === undefined || val === null) return fallbackMs;
  if (typeof val === 'number') return Math.max(0, Math.floor(val)) * 1000;
  const s = String(val).trim().toLowerCase();
  if (s.endsWith('ms')) {
    const n = parseInt(s.slice(0, -2), 10);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, n);
  } else if (s.endsWith('s')) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isNaN(n) ? fallbackMs : Math.max(0, Math.floor(n * 1000));
  } else {
    const n = parseFloat(s);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, Math.floor(n * 1000));
  }
}

function parseTimeoutToMs(val, fallbackMs) {
  if (val === undefined || val === null) return fallbackMs;
  if (typeof val === 'number') return Math.max(0, Math.floor(val));
  const s = String(val).trim().toLowerCase();
  if (s.endsWith('ms')) {
    const n = parseInt(s.slice(0, -2), 10);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, n);
  } else if (s.endsWith('s')) {
    const n = parseFloat(s.slice(0, -1));
    return Number.isNaN(n) ? fallbackMs : Math.max(0, Math.floor(n * 1000));
  } else {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, n);
  }
}

const rawArgs = parseArgs();

let httpsPort = 443;
let httpPort = 80;
let enableHttpRedirect = true;
let pfxPath = path.join(__dirname, 'your_domain.pfx');
let pfxPassphrase = undefined;

let CONCURRENCY = 10;
let INFO_TIMEOUT = 2000;
let UpdateServerIPsTimeMs = 600 * 1000;
let UpdateServerInfoTimeMs = 30 * 1000;

try {
  if (rawArgs.port !== undefined) {
    const p = toInt(rawArgs.port, null);
    if (p && p > 0 && p < 65536) {
      httpsPort = p;
    } else {
      console.warn(`[WARN] 无效的 port 值 "${rawArgs.port}"，使用默认 httpsPort=${httpsPort}`);
    }
  }

  if (rawArgs.https_port !== undefined) {
    const p = toInt(rawArgs.https_port, null);
    if (p && p > 0 && p < 65536) {
      httpsPort = p;
    } else {
      console.warn(`[WARN] 无效的 https_port 值 "${rawArgs.https_port}"，使用默认 httpsPort=${httpsPort}`);
    }
  }

  if (rawArgs.http_port !== undefined) {
    const p = toInt(rawArgs.http_port, null);
    if (p && p > 0 && p < 65536) {
      httpPort = p;
    } else {
      console.warn(`[WARN] 无效的 http_port 值 "${rawArgs.http_port}"，使用默认 httpPort=${httpPort}`);
    }
  }

  if (rawArgs.redirect_http !== undefined) {
    const v = String(rawArgs.redirect_http).toLowerCase();
    enableHttpRedirect = (v === 'true' || v === '1' || v === 'yes');
  }

  if (rawArgs.pfx_path !== undefined) {
    pfxPath = path.isAbsolute(rawArgs.pfx_path) ? rawArgs.pfx_path : path.join(process.cwd(), rawArgs.pfx_path);
  } else if (rawArgs.pfx !== undefined) {
    pfxPath = path.isAbsolute(rawArgs.pfx) ? rawArgs.pfx : path.join(process.cwd(), rawArgs.pfx);
  } else if (process.env.PFX_PATH) {
    pfxPath = path.isAbsolute(process.env.PFX_PATH) ? process.env.PFX_PATH : path.join(process.cwd(), process.env.PFX_PATH);
  } else {
    pfxPath = path.isAbsolute(pfxPath) ? pfxPath : path.join(process.cwd(), path.relative(process.cwd(), pfxPath));
  }

  if (rawArgs.pfx_passphrase !== undefined) {
    pfxPassphrase = String(rawArgs.pfx_passphrase);
  } else if (process.env.PFX_PASSPHRASE) {
    pfxPassphrase = process.env.PFX_PASSPHRASE;
  }

  if (rawArgs.concurrency !== undefined) {
    const c = toInt(rawArgs.concurrency, null);
    if (c && c > 0) {
      CONCURRENCY = c;
    } else {
      console.warn(`[WARN] 无效的 CONCURRENCY 值 "${rawArgs.concurrency}"，使用默认 CONCURRENCY=${CONCURRENCY}`);
    }
  }

  if (rawArgs.info_timeout !== undefined) {
    const t = parseTimeoutToMs(rawArgs.info_timeout, INFO_TIMEOUT);
    if (t >= 0) {
      INFO_TIMEOUT = t;
    } else {
      console.warn(`[WARN] 无效的 INFO_TIMEOUT 值 "${rawArgs.info_timeout}"，使用默认 INFO_TIMEOUT=${INFO_TIMEOUT}ms`);
    }
  } else if (rawArgs['infotimeout'] !== undefined) {
    const t = parseTimeoutToMs(rawArgs['infotimeout'], INFO_TIMEOUT);
    if (t >= 0) INFO_TIMEOUT = t;
  }

  if (rawArgs.updateserveripstime !== undefined) {
    const tms = parseIntervalToMs(rawArgs.updateserveripstime, UpdateServerIPsTimeMs);
    if (tms >= 0) {
      UpdateServerIPsTimeMs = tms;
    } else {
      console.warn(`[WARN] 无效的 UpdateServerIPsTime 值 "${rawArgs.updateserveripstime}"，使用默认 ${UpdateServerIPsTimeMs} ms`);
    }
  }

  if (rawArgs.updateserverinfotime !== undefined) {
    const tms = parseIntervalToMs(rawArgs.updateserverinfotime, UpdateServerInfoTimeMs);
    if (tms >= 0) {
      UpdateServerInfoTimeMs = tms;
    } else {
      console.warn(`[WARN] 无效的 UpdateServerInfoTime 值 "${rawArgs.updateserverinfotime}"，使用默认 ${UpdateServerInfoTimeMs} ms`);
    }
  }

} catch (e) {
  console.warn('[WARN] 解析启动参数时发生异常，使用全部默认配置：', e && e.message ? e.message : e);
}

function logStartConfig() {
  console.log('------------------ 启动配置 ------------------');
  console.log(`HTTPS_PORT: ${httpsPort}`);
  console.log(`HTTP_PORT (redirect): ${httpPort}`);
  console.log(`HTTP->HTTPS 重定向: ${enableHttpRedirect}`);
  console.log(`PFX 文件路径: ${pfxPath}`);
  console.log(`PFX 是否有提供密码: ${pfxPassphrase ? '是' : '否'}`);
  console.log(`CONCURRENCY: ${CONCURRENCY}`);
  console.log(`INFO_TIMEOUT: ${INFO_TIMEOUT} ms`);
  console.log(`UpdateServerIPsTime: ${Math.floor(UpdateServerIPsTimeMs / 1000)} s (${UpdateServerIPsTimeMs} ms)`);
  console.log(`UpdateServerInfoTime: ${Math.floor(UpdateServerInfoTimeMs / 1000)} s (${UpdateServerInfoTimeMs} ms)`);
  console.log('------------------------------------------------');
}
logStartConfig();

// 文件路径定义
const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');
const SERVER_LIST_FILE = path.join(__dirname, 'server_list.json');
const SERVER_HISTORY_FILE = path.join(__dirname, 'server_history.json');
const GLOBAL_STATS_FILE = path.join(__dirname, 'global_stats.json'); // 新增：全局统计数据文件
const TOKEN_FILE = path.join(__dirname, 'API_TOKEN.json');
const APP_ID_FILE = path.join(__dirname, 'app_id.json');
const TAGS_CACHE_FILE = path.join(__dirname, 'tags_cache.json'); // 新增 tags 缓存文件

// 缓存配置
const TAG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
const DIFF_THRESHOLD = 5; // 连续 5 次不同才更新缓存

let clients = new Set();
let geoCache = {};
let serverMap = new Map();
let serverHistory = {};
let globalStats = { // 新增：全局统计数据
  games: {},
  history: {},
  lastUpdated: null,
  currentOnline: 0 // 新增：当前在线玩家总数
};
let isUpdatingServerInfo = false;
let lastHistoryDate = null;

// 内存中的 tags 缓存结构：{ "<ip:port>": { tags: [...], lastUpdated: ms, diffCount: 0 } }
let tagsCache = {};

function log(message) {
  const now = new Date();
  const timestamp = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
  console.log(`[${timestamp}] ${message}`);
}

function serializeBigInt(obj) {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  );
}

function broadcastVisitorCount() {
  const count = clients.size;
  const message = JSON.stringify({ type: 'visitor_count', count });
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
  log(`推送在线人数: ${count} 位访客`);
}

let wss = null;

// 新增：初始化全局统计数据文件
async function initializeGlobalStatsFile() {
  try {
    await fs.access(GLOBAL_STATS_FILE);
    log('global_stats.json 文件已存在');
    const data = await fs.readFile(GLOBAL_STATS_FILE, 'utf8');
    if (data.trim()) {
      globalStats = JSON.parse(data);
      log(`成功加载全局统计数据，包含 ${Object.keys(globalStats.games).length} 个游戏的数据`);
    } else {
      log('global_stats.json 为空，初始化为空对象');
      globalStats = { games: {}, history: {}, lastUpdated: null, currentOnline: 0 };
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('global_stats.json 不存在，正在创建...');
      await fs.writeFile(GLOBAL_STATS_FILE, JSON.stringify({ games: {}, history: {}, lastUpdated: null, currentOnline: 0 }, null, 2), 'utf8');
      globalStats = { games: {}, history: {}, lastUpdated: null, currentOnline: 0 };
      log('global_stats.json 创建成功');
    } else {
      log(`检查或读取 global_stats.json 失败: ${err.message}`);
      globalStats = { games: {}, history: {}, lastUpdated: null, currentOnline: 0 };
    }
  }
}

// 新增：保存全局统计数据
async function saveGlobalStats() {
  const tempFile = GLOBAL_STATS_FILE + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify(globalStats, null, 2), 'utf8');
    await fs.rename(tempFile, GLOBAL_STATS_FILE);
    log('成功保存 global_stats.json');
  } catch (err) {
    log(`写入 global_stats.json 失败: ${err.message}`);
  }
}

// 新增：加载 tags cache 文件
async function loadTagsCacheFile() {
  try {
    await fs.access(TAGS_CACHE_FILE);
    const data = await fs.readFile(TAGS_CACHE_FILE, 'utf8');
    if (data.trim()) {
      tagsCache = JSON.parse(data);
      log(`成功加载 tags_cache.json，包含 ${Object.keys(tagsCache).length} 条缓存`);
    } else {
      tagsCache = {};
      log('tags_cache.json 为空，初始化为空对象');
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('tags_cache.json 不存在，正在创建...');
      try {
        await fs.writeFile(TAGS_CACHE_FILE, JSON.stringify({}, null, 2), 'utf8');
        tagsCache = {};
        log('tags_cache.json 创建成功');
      } catch (e) {
        log(`创建 tags_cache.json 失败: ${e.message}`);
      }
    } else {
      log(`读取 tags_cache.json 失败: ${err.message}`);
      tagsCache = {};
    }
  }
}

// 新增：保存 tags cache 文件（原子写入）
async function saveTagsCacheFile() {
  const tempFile = TAGS_CACHE_FILE + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify(tagsCache, null, 2), 'utf8');
    await fs.rename(tempFile, TAGS_CACHE_FILE);
    log('成功保存 tags_cache.json');
  } catch (err) {
    log(`写入 tags_cache.json 失败: ${err.message}`);
  }
}

// 原有的初始化函数保持不变...
async function initializeGeoCacheFile() {
  try {
    await fs.access(GEO_CACHE_FILE);
    log('geo_cache.json 文件已存在');
    const data = await fs.readFile(GEO_CACHE_FILE, 'utf8');
    if (data.trim()) {
      geoCache = JSON.parse(data);
      log(`成功加载地理信息缓存，包含 ${Object.keys(geoCache).length} 条记录`);
    } else {
      log('geo_cache.json 为空，初始化为空对象');
      geoCache = {};
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('geo_cache.json 不存在，正在创建...');
      await fs.writeFile(GEO_CACHE_FILE, JSON.stringify({}, null, 2), 'utf8');
      geoCache = {};
      log('geo_cache.json 创建成功');
    } else {
      log(`检查或读取 geo_cache.json 失败: ${err.message}`);
      geoCache = {};
    }
  }
}

async function initializeServerListFile() {
  try {
    await fs.access(SERVER_LIST_FILE);
    log('server_list.json 文件已存在');
    const data = await fs.readFile(SERVER_LIST_FILE, 'utf8');
    if (data.trim()) {
      const servers = JSON.parse(data);
      servers.forEach(server => {
        const key = `${server.ip}:${server.port}`;
        serverMap.set(key, {
          appId: server.appId || null,
          lastSuccessful: server.lastSuccessful || 0,
          failureCount: 0,
          lastData: null
        });
      });
      log(`成功加载服务器列表，包含 ${serverMap.size} 个服务器`);
    } else {
      log('server_list.json 为空，初始化为空数组');
      serverMap = new Map();
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('server_list.json 不存在，正在创建...');
      await fs.writeFile(SERVER_LIST_FILE, JSON.stringify([], null, 2), 'utf8');
      serverMap = new Map();
      log('server_list.json 创建成功');
    } else {
      log(`检查或读取 server_list.json 失败: ${err.message}`);
      serverMap = new Map();
    }
  }
}

async function initializeServerHistoryFile() {
  try {
    await fs.access(SERVER_HISTORY_FILE);
    log('server_history.json 文件已存在');
    const data = await fs.readFile(SERVER_HISTORY_FILE, 'utf8');
    if (data.trim()) {
      serverHistory = JSON.parse(data);
      log(`成功加载服务器历史数据，包含 ${Object.keys(serverHistory).length} 个服务器的历史记录`);
    } else {
      log('server_history.json 为空，初始化为空对象');
      serverHistory = {};
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      log('server_history.json 不存在，正在创建...');
      await fs.writeFile(SERVER_HISTORY_FILE, JSON.stringify({}, null, 2), 'utf8');
      serverHistory = {};
      log('server_history.json 创建成功');
    } else {
      log(`检查或读取 server_history.json 失败: ${err.message}`);
      serverHistory = {};
    }
  }
}

async function saveServerHistory() {
  const tempFile = SERVER_HISTORY_FILE + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify(serverHistory, null, 2), 'utf8');
    await fs.rename(tempFile, SERVER_HISTORY_FILE);
    log('成功保存 server_history.json');
  } catch (err) {
    log(`写入 server_history.json 失败: ${err.message}`);
  }
}

async function saveServerList() {
  const servers = Array.from(serverMap.entries()).map(([key, val]) => {
    const [ip, port] = key.split(':');
    return {
      ip,
      port: parseInt(port),
      appId: val.appId,
      lastSuccessful: val.lastSuccessful
    };
  });
  const tempFile = SERVER_LIST_FILE + '.tmp';
  try {
    await fs.writeFile(tempFile, JSON.stringify(servers, null, 2), 'utf8');
    await fs.rename(tempFile, SERVER_LIST_FILE);
    log('成功保存 server_list.json');
  } catch (err) {
    log(`写入 server_list.json 失败: ${err.message}`);
  }
}

async function loadToken() {
  try {
    const data = await fs.readFile(TOKEN_FILE, 'utf8');
    const tokens = JSON.parse(data);
    if (!tokens.IPINFO_TOKEN) throw new Error('IPINFO_TOKEN 未定义');
    return {
      IPINFO_TOKEN: tokens.IPINFO_TOKEN,
      STEAM_API_KEY: tokens.STEAM_API_KEY || null
    };
  } catch (err) {
    log(`读取 API_TOKEN.json 失败: ${err.message}`);
    throw new Error('无法加载 API token，请确保 API_TOKEN.json 存在并包含有效的 IPINFO_TOKEN（和可选的 STEAM_API_KEY）');
  }
}

// ----------------- 修复与增强区域 -----------------

/**
 * normalizeRuleValue - 将规则值转换为可读字符串或原始标量
 */
function normalizeRuleValue(v) {
  try {
    if (v === null || v === undefined) return '';
    if (Buffer.isBuffer(v)) return v.toString('utf8');
    if (typeof v === 'object') {
      // 如果是对象且有 value/name 对，应优先取这些字段
      if (v.value !== undefined && (typeof v.value === 'string' || typeof v.value === 'number' || typeof v.value === 'boolean')) {
        return String(v.value);
      }
      if (v.val !== undefined) return String(v.val);
      if (v.name !== undefined && v.value === undefined) return JSON.stringify(v);
      // 最后退回到 JSON 字符串（尽量短）
      return JSON.stringify(v);
    }
    return String(v);
  } catch (e) {
    return String(v);
  }
}

/**
 * parseRulesToObject - 将 Query.rules 的返回值统一转换为 { key => value } 形式
 * 兼容：
 *  - 直接对象 { KEY: 'VAL', ... }
 *  - 数组 [{ name:'KEY', value:'VAL' }, ['KEY','VAL'], 'KEY VAL', ...]
 *  - 各种大小写/Buffer/嵌套情况
 */
function parseRulesToObject(rulesData) {
  const out = {};
  if (!rulesData) return out;

  if (Array.isArray(rulesData)) {
    for (const entry of rulesData) {
      if (entry === null || entry === undefined) continue;
      if (typeof entry === 'string') {
        // 可能是 "KEY VAL" 或 "KEY\0VAL" 等
        const parts = entry.split(/\s+/, 2);
        if (parts.length === 2) {
          out[parts[0]] = normalizeRuleValue(parts[1]);
        } else {
          out[entry] = '';
        }
      } else if (Array.isArray(entry)) {
        // 可能是 ['KEY','VAL']
        const k = entry[0];
        const v = entry[1];
        if (k !== undefined) out[String(k)] = normalizeRuleValue(v);
      } else if (typeof entry === 'object') {
        // 常见： { name: 'KEY', value: 'VAL' } 或 { key:'KEY', val:'VAL' } 或 { 'KEY': 'VAL' }
        // 优先取 name/value、key/val、然后尝试枚举属性
        const name = entry.name || entry.key || entry.k || entry.n;
        const value = entry.value !== undefined ? entry.value : (entry.val !== undefined ? entry.val : (entry.v !== undefined ? entry.v : undefined));
        if (name !== undefined) {
          out[String(name)] = normalizeRuleValue(value === undefined ? (entry.value !== undefined ? entry.value : entry) : value);
        } else {
          // 如果对象内本身就是键->值的映射（例如 {KEY:'VAL'}）
          for (const [kk, vv] of Object.entries(entry)) {
            // 跳过原型链上的无关字段（通常不会出现）
            out[String(kk)] = normalizeRuleValue(vv);
          }
        }
      } else {
        // 其他类型，安全地 toString
        out[String(entry)] = '';
      }
    }
    return out;
  } else if (typeof rulesData === 'object') {
    // 直接对象：可能含 Buffer 或复杂值
    for (const [k, v] of Object.entries(rulesData)) {
      out[String(k)] = normalizeRuleValue(v);
    }
    return out;
  } else {
    // 兜底：转换为字符串
    out[String(rulesData)] = '';
    return out;
  }
}

/**
 * findRuleIgnoreCase - 在规则对象中按多个候选键查找（忽略大小写）
 * candidates: array of candidate keys (例如 ['FGV_s','GameVersion_s'])
 */
function findRuleIgnoreCase(rulesObj, candidates) {
  if (!rulesObj || typeof rulesObj !== 'object') return undefined;
  const lowered = {};
  for (const k of Object.keys(rulesObj)) {
    lowered[k.toLowerCase()] = rulesObj[k];
  }
  for (const c of candidates) {
    const v = lowered[c.toLowerCase()];
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * safeBool - 将规则值解析为布尔（三态：true/false/undefined）
 */
function safeBool(val) {
  if (val === undefined || val === null) return undefined;
  const s = String(val).toLowerCase().trim();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'y') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'n') return false;
  return undefined;
}

/**
 * mapServerType - 将 ServerType_i 的整数映射为可读标签
 * 0 = 不推送
 * 1 = PVE
 * 2 = PVP
 * 3 = PVP-PVE
 * 4 = RP-PVE
 * 5 = RP-PVP
 * 6 = RP-PVP-PVE
 * 返回 null 表示不推送
 */
function mapServerType(n) {
  const num = parseInt(String(n).trim(), 10);
  if (Number.isNaN(num)) return null;
  switch (num) {
    case 0: return null; // 不推送
    case 1: return 'PVE';
    case 2: return 'PVP';
    case 3: return 'PVP-PVE';
    case 4: return 'RP-PVE';
    case 5: return 'RP-PVP';
    case 6: return 'RP-PVP-PVE';
    default: return `ServerType:${num}`; // 非预期值，仍返回可读格式以便调试
  }
}

/**
 * arraysEqualIgnoreOrder - 比较两个数组（元素视为字符串）是否相等（忽略顺序）
 */
function arraysEqualIgnoreOrder(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const ma = {};
  for (const x of a) {
    const k = String(x);
    ma[k] = (ma[k] || 0) + 1;
  }
  for (const y of b) {
    const k = String(y);
    if (!ma[k]) return false;
    ma[k]--;
  }
  return true;
}

// 修复：改进的服务器查询函数 - 添加规则查询和标签生成（仅推送指定字段）
// 并实现 tags 本地缓存策略
async function queryServerInfo(ip, port) {
  try {
    const serverKey = `${ip}:${port}`;
    log(`开始查询服务器信息: ${serverKey}`);

    // 首先尝试查询基本信息
    const infoStart = process.hrtime.bigint();
    const serverInfo = await Query.info(ip, port, INFO_TIMEOUT);
    const infoEnd = process.hrtime.bigint();

    if (!serverInfo) {
      log(`服务器信息为空 (${serverKey})`);
      return null;
    }

    const latency = Number((infoEnd - infoStart) / 1000000n);
    log(`A2S_INFO 延迟 (${serverKey}): ${latency} ms`);

    log(`收到服务器信息字段 (${serverKey}): ${Object.keys(serverInfo).join(', ')}`);

    let players = [];
    try {
      const playerData = await Query.players(ip, port, INFO_TIMEOUT);
      if (Array.isArray(playerData)) {
        players = playerData.map(player => ({
          name: player.name || '-',
          score: (typeof player.score === 'number' && player.score >= 0) ? `+${player.score}` : `${player.score}`,
          duration: formatDuration(player.duration)
        }));
      } else {
        log(`玩家数据非数组或为空 (${serverKey})`);
      }
    } catch (err) {
      log(`玩家列表查询失败 (${serverKey}): ${err.message}`);
    }

    // 先检查 tags cache 是否存在且未过期
    const nowMs = Date.now();
    let tags = [];
    let rules = {};
    const cacheEntry = tagsCache[serverKey];
    if (cacheEntry && (nowMs - (cacheEntry.lastUpdated || 0) <= TAG_CACHE_TTL_MS)) {
      // 使用本地缓存的 tags，跳过 rules 查询
      tags = Array.isArray(cacheEntry.tags) ? cacheEntry.tags.slice() : [];
      log(`使用本地 tags 缓存 (${serverKey})，缓存时长 ${(nowMs - cacheEntry.lastUpdated)} ms，tags=${tags.join(', ')}`);
    } else {
      // 缓存不存在或过期，需要查询 rules
      try {
        const rulesData = await Query.rules(ip, port, INFO_TIMEOUT);
        if (rulesData) {
          rules = parseRulesToObject(rulesData);
          const ruleCount = Object.keys(rules).length;
          log(`规则查询成功 (${serverKey}): 获取到 ${ruleCount} 条规则`);
          log(`服务器 ${serverKey} 的规则详情: ${JSON.stringify(rules, null, 2)}`);

          // ---- 仅提取指定的字段并构造成 tags ----
          // 只推送这些字段：GameVersion_s、Location_s、ServerType_i、EAC_b、FGV_s、RDY_b、PVE_b、RP_b、UFL_b
          const allowedKeys = [
            { key: 'GameVersion_s', type: 'string' },
            { key: 'FGV_s', type: 'string' },
            { key: 'Location_s', type: 'string' },
            { key: 'ServerType_i', type: 'servertype' }, // 特殊处理：映射为友好字符串或不推送
            { key: 'EAC_b', type: 'bool' },
            // { key: 'RDY_b', type: 'bool' },
            { key: 'PVE_b', type: 'bool' },
            { key: 'RP_b', type: 'bool' },
            { key: 'UFL_b', type: 'bool' }
          ];

          let foundAnyAllowedKey = false;
          const newTags = [];

          for (const item of allowedKeys) {
            const k = item.key;
            const t = item.type;
            // 用 findRuleIgnoreCase 来识别 key 是否存在（忽略大小写）
            const foundVal = findRuleIgnoreCase(rules, [k]);
            if (foundVal === undefined || foundVal === null || String(foundVal).trim() === '') {
              // 仅当键不存在或值为空时跳过
              continue;
            }

            foundAnyAllowedKey = true; // 只要找到任一允许的键，标记为成功（用于缓存策略）

            if (t === 'string') {
              const s = String(foundVal).trim();
              if (s.length > 0) {
                newTags.push(s);
                log(`从规则 ${k} 添加标签: ${s}`);
              }
            } else if (t === 'servertype') {
              const mapped = mapServerType(foundVal);
              if (mapped) {
                newTags.push(mapped);
                log(`从规则 ${k} 添加映射标签: ${mapped} (原始=${String(foundVal).trim()})`);
              } else {
                log(`规则 ${k} 值为 0 或映射为 null，已跳过推送`);
              }
            } else if (t === 'bool') {
              // 处理特殊布尔键：
              // - PVE_b: 只要键存在就推送 PvE（true）或 PvP（false）
              // - EAC_b: 只要键存在，若 true 推送 NoEAC，若 false 推送 EAC（按你的要求反转）
              // - 其它布尔键（RDY_b、RP_b、UFL_b）：只有为 true 时推送
              const loweredKey = String(k).toLowerCase();
              if (loweredKey === 'pve_b' || loweredKey === 'pve') {
                const b = safeBool(foundVal);
                if (b === true) {
                  newTags.push('PvE');
                  log(`从规则 ${k} 添加布尔标签: PvE`);
                } else if (b === false) {
                  newTags.push('PvP');
                  log(`从规则 ${k} 添加布尔标签: PvP (PVE_b 明确为 false)`);
                } else {
                  log(`规则 ${k} 值无法解析为布尔，跳过`);
                }
              } else if (loweredKey === 'eac_b' || loweredKey === 'eac') {
                // 反转逻辑：存在且 true -> 推送 NoEAC；存在且 false -> 推送 EAC
                const b = safeBool(foundVal);
                if (b === true) {
                  newTags.push('NoEAC');
                  log(`从规则 ${k} 添加布尔标签: NoEAC (EAC_b=true 表示无 EAC)`);
                } else if (b === false) {
                  newTags.push('EAC');
                  log(`从规则 ${k} 添加布尔标签: EAC (EAC_b=false 表示有 EAC)`);
                } else {
                  log(`规则 ${k} 值无法解析为布尔，跳过`);
                }
              } else {
                const b = safeBool(foundVal);
                if (b === true) {
                  let pushTag = k;
                  if (k.toLowerCase().startsWith('rp')) pushTag = 'RP';
                  // else if (k.toLowerCase().startsWith('rdy')) pushTag = 'RDY'; // 没啥用
                  else if (k.toLowerCase().startsWith('ufl')) pushTag = 'UFL';
                  // else if (k.toLowerCase().startsWith('eac')) pushTag = 'NoEAC'; // EAC_b 已被上面处理
                  newTags.push(pushTag);
                  log(`从规则 ${k} 添加布尔标签: ${pushTag}`);
                } else {
                  log(`规则 ${k} 为 false 或不可判定，跳过推送 (${k}=${String(foundVal)})`);
                }
              }
            }
          } // end for allowedKeys

          // 去重并限制数量
          const uniq = [];
          for (const t of newTags) {
            if (!uniq.includes(t)) uniq.push(t);
          }
          if (uniq.length > 12) uniq.splice(12);
          // 将 newTags 赋给 tags 以便推送（我们会依据缓存策略决定是否写缓存）
          tags = uniq;

          // 缓存策略：只要任意 allowedKey 存在，就视为“查询成功”，并按下面规则处理缓存
          if (foundAnyAllowedKey) {
            const existing = tagsCache[serverKey];
            if (!existing) {
              // 没有缓存，直接写入并保存（首次发现就缓存 5 分钟）
              tagsCache[serverKey] = {
                tags: tags.slice(),
                lastUpdated: Date.now(),
                diffCount: 0
              };
              await saveTagsCacheFile();
              log(`首次缓存 tags (${serverKey}) -> ${tags.join(', ')}`);
            } else {
              // 有缓存：比较新 tags 与缓存 tags
              if (arraysEqualIgnoreOrder(existing.tags, tags)) {
                // 相同：重置 diffCount 并刷新 lastUpdated（延长缓存有效期）
                existing.diffCount = 0;
                existing.lastUpdated = Date.now();
                await saveTagsCacheFile();
                log(`查询结果与缓存相同 (${serverKey})，刷新缓存时间并保持 tags 不变`);
              } else {
                // 不同：增加 diffCount；仅当 diffCount 达到阈值才真正替换缓存
                existing.diffCount = (existing.diffCount || 0) + 1;
                log(`查询结果与缓存不同 (${serverKey})，diffCount=${existing.diffCount}/${DIFF_THRESHOLD}`);
                if (existing.diffCount >= DIFF_THRESHOLD) {
                  existing.tags = tags.slice();
                  existing.lastUpdated = Date.now();
                  existing.diffCount = 0;
                  await saveTagsCacheFile();
                  log(`连续 ${DIFF_THRESHOLD} 次不同，已更新本地缓存 (${serverKey}) -> ${tags.join(', ')}`);
                } else {
                  // 仍然保留旧缓存，等待更多差异次数
                  await saveTagsCacheFile();
                }
              }
            }
          } else {
            log(`规则查询成功但未找到任何允许的键 (${serverKey})，不做缓存更改`);
          }
        } else {
          log(`规则查询返回空 (${serverKey})`);
        }
      } catch (err) {
        log(`规则查询失败 (${serverKey}): ${err && err.message ? err.message : err}`);
      }
    } // end else (cache expired path)

    const rawMaxPlayers = serverInfo.maxPlayers || serverInfo.max_players || 0;
    const max_players = rawMaxPlayers < 0 ? rawMaxPlayers + 256 : rawMaxPlayers;
    const info = {
      ip,
      port,
      game_description: serverInfo.game || '-',
      name: serverInfo.name || '-',
      map: serverInfo.map || '-',
      version: serverInfo.version || '-',
      current_players: serverInfo.players || 0,
      max_players,
      os: serverInfo.environment === 'l' ? 'Linux' :
          serverInfo.environment === 'w' ? 'Windows' :
          serverInfo.environment === 'm' ? 'macOS' : '-',
      players,
      latency,
      tags, // 仅包含允许的标签（可能来自缓存或实时查询）
      rules // 仍保留规则字段用于调试（若未查询 rules 则为空对象）
    };

    log(`返回服务器信息 (${ip}:${port}): current_players=${info.current_players}, max_players=${info.max_players}, latency=${info.latency}ms, tags=${tags.join(', ')}`);
    return info;
  } catch (err) {
    log(`服务器查询总体失败 (${ip}:${port}): ${err && err.message ? err.message : err}`);
    return null;
  }
}

// ----------------------------------------------------

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h${m}m${s}s`;
}

async function asyncPool(items, poolLimit, iteratorFn) {
  const ret = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);

    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean).catch(clean);

    if (executing.size >= poolLimit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}

async function getGeoInfo(ip) {
  if (geoCache[ip] && geoCache[ip].country && geoCache[ip].isp) {
    log(`使用缓存数据: ${ip} - ${geoCache[ip].country}`);
    return geoCache[ip];
  }

  try {
    const tokens = await loadToken();
    const IPINFO_TOKEN = tokens.IPINFO_TOKEN;
    log(`查询地理信息: ${ip}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`, { signal: controller.signal });
    clearTimeout(timeoutId);
    const data = await response.json();
    log(`收到地理信息: ${ip} - ${JSON.stringify(data)}`);

    const geoInfo = {
      country: data.country || 'unknown',
      isp: data.org ? data.org.split(' ').slice(1).join(' ') : '-'
    };

    geoCache[ip] = geoInfo;
    await saveGeoCache();
    return geoInfo;
  } catch (err) {
    log(`地理信息查询失败 (${ip}): ${err.message}`);
    return { country: 'unknown', isp: '-' };
  }
}

async function saveGeoCache() {
  try {
    await fs.writeFile(GEO_CACHE_FILE, JSON.stringify(geoCache, null, 2), 'utf8');
    log('成功保存 geo_cache.json');
  } catch (err) {
    log(`写入 geo_cache.json 失败: ${err.message}`);
  }
}

// 原有的主服务器列表获取函数保持不变...
async function getMasterServerList(appId, filter = {}) {
  const tokens = await (async () => {
    try {
      return await loadToken();
    } catch (e) {
      return { IPINFO_TOKEN: null, STEAM_API_KEY: null };
    }
  })();

  const steamKey = tokens.STEAM_API_KEY;

  function filterObjToString(obj) {
    if (!obj || Object.keys(obj).length === 0) return `\\appid\\${appId}`;
    let parts = [`\\appid\\${appId}`];
    for (const [k, v] of Object.entries(obj)) {
      if (v === true) {
        parts.push(`\\${k}\\1`);
      } else if (v === false) {
        parts.push(`\\${k}\\0`);
      } else {
        parts.push(`\\${k}\\${v}`);
      }
    }
    return parts.join('');
  }

  if (steamKey) {
    const filterString = filterObjToString(filter);
    const baseUrl = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/';
    const limit = 50000;
    const url = `${baseUrl}?key=${encodeURIComponent(steamKey)}&filter=${encodeURIComponent(filterString)}&limit=${limit}`;
    log(`使用 Steam Web API 查询 APPID ${appId} 的服务器列表（filter=${filterString}，limit=${limit}）`);
    
    let attempt = 0;
    const maxAttempts = 4;
    let lastErr = null;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const controller = new AbortController();
        const timeoutMs = 10000 + attempt * 2000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!resp.ok) {
          if (resp.status === 403) {
            log(`Steam Web API 返回 403（可能需要 publisher key 或账号权限），停止使用 Web API：HTTP 403`);
            lastErr = new Error('Steam Web API 403 Forbidden');
            break;
          }
          const text = await resp.text().catch(()=>'<no-body>');
          lastErr = new Error(`Steam Web API HTTP ${resp.status} - ${text}`);
          log(`Steam Web API 返回 HTTP ${resp.status}，尝试重试（${attempt}/${maxAttempts}）: ${text}`);
          if (resp.status >= 500 || resp.status === 429) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
          } else {
            break;
          }
        }

        const data = await resp.json();
        if (!data || !data.response) {
          log(`Steam Web API 返回格式异常，response 字段缺失，内容: ${JSON.stringify(data).slice(0,300)}`);
          return [];
        }
        const servers = data.response.servers || [];
        log(`Steam Web API 返回 ${servers.length} 台服务器（APPID ${appId}）`);
        
        const parsed = servers.map(s => {
          const addr = s.addr || s.addrString || s.ip || '';
          const addrStr = String(addr);
          const parts = addrStr.split(':');
          const ip = parts[0] || '';
          const port = parts[1] ? parseInt(parts[1], 10) : (s.gameport || s.hostport || 0);
          return { ip, port: port || 0, appId };
        }).filter(s => s.ip && s.port);
        return parsed;
      } catch (err) {
        lastErr = err;
        log(`调用 Steam Web API 失败（第 ${attempt} 次）: ${err && err.message ? err.message : err}`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    
    if (lastErr) {
      log(`Steam Web API 调用最终失败: ${lastErr.message}`);
    }
    
    log('尝试降级：如果你仍然需要通过匿名 UDP master 查询，请确认 Valve 没有对该 APPID 限制。降级可能也会失败或被 rate-limited。');
  } else {
    log('未配置 STEAM_API_KEY，无法使用 Steam Web API 获取服务器列表；将尝试匿名 UDP 查询（可能已被 Valve 限制/拒绝）');
  }

  try {
    const { queryMasterServer, REGIONS } = require('steam-server-query');
    const masterServerAddress = 'hl2master.steampowered.com:27011';
    const region = REGIONS.ALL;
    const filterOptions = { appid: appId, ...filter };
    log(`尝试使用匿名 UDP master (${masterServerAddress}) 查询 APPID ${appId}（降级路径）`);
    const servers = await queryMasterServer(masterServerAddress, region, filterOptions);
    log(`匿名 UDP master 返回 ${servers.length} 条记录（可能被截断/限速）`);
    return servers.map(server => {
      const [ip, port] = server.split(':');
      return { ip, port: parseInt(port), appId };
    });
  } catch (err) {
    log(`降级的匿名 UDP master 查询失败或未安装依赖: ${err && err.message ? err.message : err}`);
    return [];
  }
}

async function updateServerIPs() {
  let appIds = [];
  try {
    const data = await fs.readFile(APP_ID_FILE, 'utf8');
    appIds = JSON.parse(data);
    log(`加载 app_id.json，包含 ${appIds.length} 个 APPID`);
  } catch (err) {
    log(`读取 app_id.json 失败: ${err.message}`);
    return;
  }

  let newServers = [];
  for (const appId of appIds) {
    const servers = await getMasterServerList(appId);
    newServers = newServers.concat(servers);
  }

  const uniqueNewServers = newServers.filter(server => !serverMap.has(`${server.ip}:${server.port}`));
  if (uniqueNewServers.length > 0) {
    uniqueNewServers.forEach(server => {
      const key = `${server.ip}:${server.port}`;
      serverMap.set(key, {
        appId: server.appId,
        lastSuccessful: Date.now(),
        failureCount: 0,
        lastData: null
      });
    });
    await saveServerList();
    log(`新增 ${uniqueNewServers.length} 个服务器IP到 server_list.json`);
  } else {
    log('没有新的服务器IP');
  }
}

// 新增：获取本地日期字符串
function getLocalDateString(date) {
  const now = date ? new Date(date) : new Date();
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 新增：检查是否需要重置历史数据（新的一天）
function checkAndResetHistoryIfNewDay() {
  const today = getLocalDateString();
  
  if (lastHistoryDate !== today) {
    log(`检测到新的一天: ${lastHistoryDate || '无记录'} -> ${today}`);
    lastHistoryDate = today;
    return true;
  }
  
  return false;
}

// 修复问题1：修改更新服务器历史数据函数，防止数据膨胀
async function updateServerHistory(serverInfo) {
  try {
    const key = `${serverInfo.ip}:${serverInfo.port}`;
    const today = getLocalDateString();
    
    // 确保服务器历史数据存在
    if (!serverHistory[key]) {
      serverHistory[key] = {
        name: serverInfo.name,
        ip: serverInfo.ip,
        port: serverInfo.port,
        history: {}
      };
    }
    
    // 更新今天的在线人数（取最大值）
    const serverData = serverHistory[key];
    const currentPlayers = serverInfo.current_players || 0;
    
    // 只在当前玩家数大于0且大于历史记录时才更新
    if (currentPlayers > 0 && (!serverData.history[today] || currentPlayers > serverData.history[today])) {
      serverData.history[today] = currentPlayers;
      log(`更新服务器历史数据: ${key} - ${today}: ${currentPlayers} 玩家`);
    }
    
    // 清理超过30天的数据
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const thirtyDaysAgoStr = getLocalDateString(thirtyDaysAgo);
    
    Object.keys(serverData.history).forEach(date => {
      if (date < thirtyDaysAgoStr) {
        delete serverData.history[date];
      }
    });
    
    await saveServerHistory();
  } catch (err) {
    log(`更新服务器历史数据失败: ${err.message}`);
  }
}

// 修复问题2：修改更新全局统计数据函数，立即更新历史记录
async function updateGlobalStats(serverInfo) {
  try {
    const today = getLocalDateString();
    const appId = serverInfo.appId;
    
    if (!appId) return;
    
    // 确保游戏数据存在
    if (!globalStats.games[appId]) {
      globalStats.games[appId] = {
        name: serverInfo.game_description,
        totalServers: 0,
        maxPlayers: 0,
        currentPlayers: 0
      };
    }
    
    const gameData = globalStats.games[appId];
    
    // 更新游戏名称（如果发生变化）
    if (serverInfo.game_description && serverInfo.game_description !== '-') {
      gameData.name = serverInfo.game_description;
    }
    
    // 重新计算总服务器数量和当前在线玩家数
    let totalServers = 0;
    let currentPlayers = 0;
    
    // 遍历所有服务器，统计该游戏的数据
    for (const [key, server] of serverMap.entries()) {
      if (server.appId === appId && server.lastData && !server.lastData.offline) {
        totalServers++;
        currentPlayers += server.lastData.current_players || 0;
      }
    }
    
    gameData.totalServers = totalServers;
    gameData.currentPlayers = currentPlayers;
    
    // 确保历史数据存在
    if (!globalStats.history[today]) {
      globalStats.history[today] = {};
    }
    
    // 修复问题2：立即更新今天的最大在线人数
    const todayPlayers = globalStats.history[today][appId] || 0;
    if (currentPlayers > todayPlayers) {
      globalStats.history[today][appId] = currentPlayers;
      log(`立即更新全局历史记录: ${appId} - ${today}: ${currentPlayers} 玩家`);
    }
    
    // 更新游戏的历史最大在线人数
    if (currentPlayers > gameData.maxPlayers) {
      gameData.maxPlayers = currentPlayers;
      log(`更新游戏历史最大在线人数: ${appId}: ${gameData.maxPlayers} 玩家`);
    }
    
    // 更新最后更新时间
    globalStats.lastUpdated = new Date().toISOString();
    
    // 清理超过1年的历史数据
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAgoStr = getLocalDateString(oneYearAgo);
    
    Object.keys(globalStats.history).forEach(date => {
      if (date < oneYearAgoStr) {
        delete globalStats.history[date];
      }
    });
    
    await saveGlobalStats();
  } catch (err) {
    log(`更新全局统计数据失败: ${err.message}`);
  }
}

// 修复问题3：确保单个服务器历史数据正常工作
async function updateServerInfo() {
  if (isUpdatingServerInfo) {
    log('上一次更新仍在进行中，跳过本次执行');
    return;
  }
  isUpdatingServerInfo = true;

  try {
    // 检查是否是新的一天，如果是则记录日志
    if (checkAndResetHistoryIfNewDay()) {
      log(`新的一天开始，将继续记录历史数据: ${lastHistoryDate}`);
    }
    
    const keys = Array.from(serverMap.keys());
    log(`开始并发查询 ${keys.length} 台服务器信息（并发上限 ${CONCURRENCY}）`);

    // 重置当前在线玩家总数
    globalStats.currentOnline = 0;

    const results = await asyncPool(keys, CONCURRENCY, async (key) => {
      const server = serverMap.get(key);
      const [ip, portStr] = key.split(':');
      const port = parseInt(portStr);
      const info = await queryServerInfo(ip, port);
      if (info) {
        const geo = await getGeoInfo(ip);
        const data = { 
          ...info, 
          ...geo, 
          offline: false,
          appId: server.appId // 确保appId被包含
        };
        server.lastData = data;
        server.failureCount = 0;
        server.lastSuccessful = Date.now();
        
        // 修复问题1：更新服务器历史数据（防止膨胀）
        await updateServerHistory(data);
        
        // 修复问题2：更新全局统计数据（立即更新历史记录）
        await updateGlobalStats(data);
        
        // 累加当前在线玩家总数
        globalStats.currentOnline += (data.current_players || 0);
        
        return data;
      } else {
        server.failureCount = (server.failureCount || 0) + 1;
        if (server.failureCount >= 3) {
          if (server.lastData) {
            const offlineData = {
              ...server.lastData,
              offline: true,
              current_players: 0,
              players: [],
              latency: -1
            };
            server.lastData = offlineData;
            return offlineData;
          } else {
            serverMap.delete(key);
            return null;
          }
        } else {
          return null;
        }
      }
    });

    const pushDatas = results.filter(r => r !== null);
    pushDatas.forEach(serverData => {
      clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(serializeBigInt(serverData));
        }
      });
    });
    log(`推送了 ${pushDatas.length} 个服务器更新到 ${clients.size} 个客户端，当前在线玩家总数: ${globalStats.currentOnline}`);
    broadcastVisitorCount();
  } catch (err) {
    log(`更新服务器信息失败: ${err.message}`);
  } finally {
    await saveServerList();
    isUpdatingServerInfo = false;
  }
}

async function cleanServerList() {
  let appIds = [];
  try {
    const data = await fs.readFile(APP_ID_FILE, 'utf8');
    appIds = JSON.parse(data);
  } catch (err) {
    log(`读取 app_id.json 失败: ${err.message}`);
    return;
  }

  let changed = false;
  for (const [key, server] of serverMap.entries()) {
    if (server.appId === null || !appIds.includes(server.appId)) {
      serverMap.delete(key);
      changed = true;
      log(`移除非法服务器 (appId 不匹配): ${key}`);
    } else if (Date.now() - server.lastSuccessful > 86400000) {
      serverMap.delete(key);
      changed = true;
      log(`移除连续离线超过一天的服务器: ${key}`);
    }
  }

  if (changed) {
    await saveServerList();
  } else {
    log('服务器列表检查无变更');
  }
}

// 启动服务器和服务
async function startServersAndServices() {
  // 检查 pfx 文件
  try {
    await fs.access(pfxPath);
  } catch (err) {
    log(`PFX 文件不存在或无法访问: ${pfxPath} - ${err.message}`);
    log('请确保 pfx 文件存在于指定路径，或者通过 --pfx_path / --pfx 指定正确路径。程序退出。');
    process.exit(1);
  }

  let pfxBuffer;
  try {
    pfxBuffer = fsSync.readFileSync(pfxPath);
    log(`已加载 PFX 文件: ${pfxPath} (${pfxBuffer.length} bytes)`);
  } catch (err) {
    log(`读取 PFX 文件失败: ${err.message}`);
    process.exit(1);
  }

  const httpsOptions = {
    pfx: pfxBuffer,
    passphrase: pfxPassphrase
  };

  const httpsServer = https.createServer(httpsOptions, app);

  wss = new WebSocket.Server({ server: httpsServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    clients.add(ws);
    log('新客户端已连接 (wss)');
    broadcastVisitorCount();

    log('向新客户端推送缓存的服务器数据');
    for (const server of serverMap.values()) {
      if (server.lastData) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(serializeBigInt(server.lastData));
        }
      }
    }

    ws.on('close', () => {
      clients.delete(ws);
      log('客户端已断开');
      broadcastVisitorCount();
    });
  });

  let httpServer = null;
  if (enableHttpRedirect) {
    httpServer = http.createServer((req, res) => {
      const hostHeader = req.headers.host || '';
      let hostOnly = hostHeader;
      if (hostHeader.includes(':')) {
        hostOnly = hostHeader.split(':')[0];
      }
      let targetHost = hostOnly;
      if (httpsPort !== 443) {
        targetHost = `${hostOnly}:${httpsPort}`;
      }
      const location = `https://${targetHost}${req.url}`;
      res.writeHead(301, { Location: location });
      res.end(`Redirecting to ${location}`);
    });

    httpServer.on('error', (err) => {
      log(`HTTP 重定向服务器错误: ${err.message}`);
    });
  }

  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    log(`HTTPS 服务器运行在 https://0.0.0.0:${httpsPort}`);
    log(`WebSocket 服务器运行在 wss://0.0.0.0:${httpsPort}/ws`);
  });

  if (enableHttpRedirect && httpServer) {
    httpServer.listen(httpPort, '0.0.0.0', () => {
      log(`HTTP 重定向服务器运行在 http://0.0.0.0:${httpPort} (重定向到 HTTPS)`);
    });
  }

  // 初始化所有数据文件（包含 tags cache）
  try {
    await Promise.all([
      initializeGeoCacheFile(),
      initializeServerListFile(),
      initializeServerHistoryFile(),
      initializeGlobalStatsFile(),
      loadTagsCacheFile() // 加载 tags 缓存
    ]);
  } catch (err) {
    log(`初始化文件失败: ${err.message}`);
  }

  // 初始化lastHistoryDate
  lastHistoryDate = getLocalDateString();
  log(`当前日期: ${lastHistoryDate}`);

  // 立即清理一次
  await cleanServerList();

  // 设置定时任务
  setInterval(updateServerIPs, UpdateServerIPsTimeMs);
  setInterval(updateServerInfo, UpdateServerInfoTimeMs);
  setInterval(cleanServerList, 3600000);

  // 立即触发一次
  updateServerIPs();
  updateServerInfo();
}

// Express 路由
app.get('/api/servers', async (req, res) => {
  log('收到 /api/servers 请求');
  res.json({ message: '服务器列表已通过 WebSocket 推送' });
});

// 获取服务器历史数据的API端点
app.get('/api/server-history/:key', async (req, res) => {
  try {
    const key = req.params.key;
    if (serverHistory[key]) {
      res.json(serverHistory[key]);
    } else {
      res.status(404).json({ error: '未找到该服务器的历史数据' });
    }
  } catch (err) {
    res.status(500).json({ error: '获取服务器历史数据失败' });
  }
});

// 新增：获取全局统计数据的API端点
app.get('/api/global-stats', async (req, res) => {
  try {
    res.json(globalStats);
  } catch (err) {
    res.status(500).json({ error: '获取全局统计数据失败' });
  }
});

// 安全修复：阻止访问敏感文件
app.use((req, res, next) => {
  const blockedFiles = ['API_TOKEN.json', 'geo_cache.json', 'server_list.json', 'server_history.json', 'global_stats.json', 'app_id.json', 'your_domain.pfx', 'tags_cache.json'];
  const requestedFile = path.basename(req.path);
  if (blockedFiles.includes(requestedFile)) {
    return res.status(403).send('Forbidden');
  }
  next();
});

app.use(express.static(__dirname));

// 启动整个服务
startServersAndServices().catch(err => {
  log(`启动失败: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
