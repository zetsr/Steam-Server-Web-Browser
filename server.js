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
// const { queryMasterServer, REGIONS } = require('steam-server-query');
// 注意：我们不再依赖匿名 queryMasterServer 作为主方式（Valve 对匿名 Master UDP 限制/变化较多）
// 仍然保留可能的降级逻辑，但主流程使用 Steam Web API（IGameServersService/GetServerList）

const app = express();

// -----------------------------
// 启动参数解析（大小写不敏感、优雅降级）
// 支持形式：--port=3000 或 --PORT=3000 或 --port 3000
// 支持时间参数单位： "30s" (秒), "30000ms" (毫秒)，对于 UpdateServer* 默认把裸数字当作 秒；
// 对于 INFO_TIMEOUT 裸数字当作 毫秒。
// 另外新增/支持参数：
// --https_port (HTTPS 端口，兼容旧的 --port)
// --http_port (HTTP 端口，用于 HTTP->HTTPS 重定向，默认 80)
// --redirect_http (true/false, 是否启用 HTTP->HTTPS 重定向，默认 true)
// --pfx_path 或 --pfx (pfx 相对或绝对路径，命令行优先)
// --pfx_passphrase (pfx 密码，可选；或用环境变量 PFX_PASSPHRASE)
// 环境变量 PFX_PATH 可作为后备
// 默认 pfx 文件名为 ./your_domain.pfx（请在部署时替换为你的证书文件）
// -----------------------------
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

// 解析 UpdateServerIPsTime / UpdateServerInfoTime：默认把裸数字当作 秒 -> 返回毫秒
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
    // 裸数字：当作秒
    const n = parseFloat(s);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, Math.floor(n * 1000));
  }
}

// 解析 INFO_TIMEOUT：裸数字当作毫秒；支持 's' / 'ms'
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
    // 裸数字：当作毫秒
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? fallbackMs : Math.max(0, n);
  }
}

const rawArgs = parseArgs();

// 默认值
let httpsPort = 443; // default HTTPS
let httpPort = 80; // default HTTP redirect port
let enableHttpRedirect = true;
let pfxPath = path.join(__dirname, 'your_domain.pfx'); // <- 默认改为 your_domain.pfx
let pfxPassphrase = undefined;

let CONCURRENCY = 10; // 并发上限（根据机器能力调节；测试时可降到 5/10）
let INFO_TIMEOUT = 2000; // ms，用于 Query.info 的超时
let UpdateServerIPsTimeMs = 600 * 1000; // 默认 600 秒 -> ms
let UpdateServerInfoTimeMs = 30 * 1000; // 默认 30 秒 -> ms

// 从 rawArgs 中读取并校验
try {
  // 兼容旧的 --port，把它当作 HTTPS 端口
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

  // pfx_path 或 pfx（命令行优先）
  if (rawArgs.pfx_path !== undefined) {
    pfxPath = path.isAbsolute(rawArgs.pfx_path) ? rawArgs.pfx_path : path.join(process.cwd(), rawArgs.pfx_path);
  } else if (rawArgs.pfx !== undefined) {
    pfxPath = path.isAbsolute(rawArgs.pfx) ? rawArgs.pfx : path.join(process.cwd(), rawArgs.pfx);
  } else if (process.env.PFX_PATH) {
    pfxPath = path.isAbsolute(process.env.PFX_PATH) ? process.env.PFX_PATH : path.join(process.cwd(), process.env.PFX_PATH);
  } else {
    // 保持默认（./your_domain.pfx）
    pfxPath = path.isAbsolute(pfxPath) ? pfxPath : path.join(process.cwd(), path.relative(process.cwd(), pfxPath));
  }

  if (rawArgs.pfx_passphrase !== undefined) {
    pfxPassphrase = String(rawArgs.pfx_passphrase);
  } else if (process.env.PFX_PASSPHRASE) {
    pfxPassphrase = process.env.PFX_PASSPHRASE;
  }

  // concurrency
  if (rawArgs.concurrency !== undefined) {
    const c = toInt(rawArgs.concurrency, null);
    if (c && c > 0) {
      CONCURRENCY = c;
    } else {
      console.warn(`[WARN] 无效的 CONCURRENCY 值 "${rawArgs.concurrency}"，使用默认 CONCURRENCY=${CONCURRENCY}`);
    }
  }

  // INFO_TIMEOUT
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

  // UpdateServerIPsTime
  if (rawArgs.updateserveripstime !== undefined) {
    const tms = parseIntervalToMs(rawArgs.updateserveripstime, UpdateServerIPsTimeMs);
    if (tms >= 0) {
      UpdateServerIPsTimeMs = tms;
    } else {
      console.warn(`[WARN] 无效的 UpdateServerIPsTime 值 "${rawArgs.updateserveripstime}"，使用默认 ${UpdateServerIPsTimeMs} ms`);
    }
  }

  // UpdateServerInfoTime
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

// 打印最终使用的配置
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

// -----------------------------
// 下面是你原有的逻辑（尽量保持不变）
// 我们将在异步初始化里启动 HTTPS/HTTP 并挂载 WebSocket Server
// -----------------------------

const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');
const SERVER_LIST_FILE = path.join(__dirname, 'server_list.json');
const SERVER_HISTORY_FILE = path.join(__dirname, 'server_history.json'); // 新增：服务器历史数据文件
const TOKEN_FILE = path.join(__dirname, 'API_TOKEN.json');
const APP_ID_FILE = path.join(__dirname, 'app_id.json');

let clients = new Set();
let geoCache = {};
let serverMap = new Map(); // key: 'ip:port', value: {appId, lastSuccessful: number, failureCount: number, lastData: object|null}
let serverHistory = {}; // 新增：存储服务器历史数据
let isUpdatingServerInfo = false;
let lastHistoryDate = null; // 新增：记录上次统计的日期

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

let wss = null; // will be created after server startup

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

// 新增：初始化服务器历史数据文件
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

// 新增：保存服务器历史数据
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
    // STEAM_API_KEY 可选，但强烈建议提供以避免匿名 UDP 被限制
    return {
      IPINFO_TOKEN: tokens.IPINFO_TOKEN,
      STEAM_API_KEY: tokens.STEAM_API_KEY || null
    };
  } catch (err) {
    log(`读取 API_TOKEN.json 失败: ${err.message}`);
    throw new Error('无法加载 API token，请确保 API_TOKEN.json 存在并包含有效的 IPINFO_TOKEN（和可选的 STEAM_API_KEY）');
  }
}

/**
 * 使用 source-server-query 的 Query.info/players（稳定）
 * 对同一个目标一次性 ping 3 次，取最短延迟作为结果
 * 使用 process.hrtime.bigint() 精确计时
 */
async function queryServerInfo(ip, port) {
  try {
    log(`开始查询服务器信息: ${ip}:${port} (ping 3次)`);

    // 定义单次查询函数
    const singleQuery = async (attempt) => {
      try {
        const infoStart = process.hrtime.bigint();
        const serverInfo = await Query.info(ip, port, INFO_TIMEOUT);
        const infoEnd = process.hrtime.bigint();

        if (!serverInfo) {
          log(`第 ${attempt} 次查询服务器信息为空 (${ip}:${port})`);
          return null;
        }

        const latency = Number((infoEnd - infoStart) / 1000000n); // ms
        log(`第 ${attempt} 次 A2S_INFO 延迟 (${ip}:${port}): ${latency} ms`);
        
        return { serverInfo, latency };
      } catch (err) {
        log(`第 ${attempt} 次服务器查询失败 (${ip}:${port}): ${err.message}`);
        return null;
      }
    };

    // 同时发起3次ping请求
    const pingPromises = [
      singleQuery(1),
      singleQuery(2),
      singleQuery(3),
      singleQuery(4),
      singleQuery(5)
    ];

    const results = await Promise.allSettled(pingPromises);
    
    // 筛选成功的结果
    const successfulResults = results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => result.value);

    if (successfulResults.length === 0) {
      log(`所有 3 次 ping 均失败 (${ip}:${port})`);
      return null;
    }

    // 选择延迟最短的结果
    const bestResult = successfulResults.reduce((best, current) => {
      return (!best || current.latency < best.latency) ? current : best;
    }, null);

    log(`最佳 ping 结果 (${ip}:${port}): ${bestResult.latency} ms (${successfulResults.length}/3 成功)`);
    
    const serverInfo = bestResult.serverInfo;
    const latency = bestResult.latency;

    log(`收到服务器信息字段 (${ip}:${port}): ${Object.keys(serverInfo).join(', ')}`);

    // players 单独查询，不计入 latency（使用最佳延迟对应的连接）
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
        log(`玩家数据非数组或为空 (${ip}:${port})`);
      }
    } catch (err) {
      log(`玩家列表查询失败 (${ip}:${port}): ${err.message}`);
    }

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
      latency
    };

    log(`返回服务器信息 (${ip}:${port}): current_players=${info.current_players}, max_players=${info.max_players}, latency=${info.latency}ms`);
    return info;
  } catch (err) {
    log(`服务器查询总体失败 (${ip}:${port}): ${err.message}`);
    return null;
  }
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h${m}m${s}s`;
}

// 并发池：限制同时进行的查询数，避免系统排队
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

/**
 * 新核心：优先使用 Steam Web API（IGameServersService/GetServerList）获取 APPID 的服务器列表
 * - 需要在 API_TOKEN.json 中配置 STEAM_API_KEY（推荐）
 * - 如果 STEAM_API_KEY 不存在或调用失败（403 等），会记录日志并返回空数组（或降级到 UDP 原方法，如果你仍然想用）
 * - 实现了简单的重试/背离策略，避免被短时 rate limit 杀死
 */
async function getMasterServerList(appId, filter = {}) {
  // filter 参数目前仍然保留（你传进来的对象会被转为filter字符串），但 Web API 只支持 filter string like "\appid\12345\secure\1" 等
  // 我们优先使用 Steam Web API：IGameServersService/GetServerList
  const tokens = await (async () => {
    try {
      return await loadToken();
    } catch (e) {
      return { IPINFO_TOKEN: null, STEAM_API_KEY: null };
    }
  })();

  const steamKey = tokens.STEAM_API_KEY;

  // 将 filter 对象转换成 master filter 字符串（例如 {secure:1} -> "\secure\1"）
  function filterObjToString(obj) {
    if (!obj || Object.keys(obj).length === 0) return `\\appid\\${appId}`;
    let parts = [`\\appid\\${appId}`];
    for (const [k, v] of Object.entries(obj)) {
      // 如果值为 true/1 等处理
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

  // 如果有 STEAM_API_KEY，优先使用 Web API
  if (steamKey) {
    const filterString = filterObjToString(filter);
    const baseUrl = 'https://api.steampowered.com/IGameServersService/GetServerList/v1/';
    // 尝试拉取大数量（但注意上游可能有实际限制）
    const limit = 50000; // 大值，但上游可能限制
    const url = `${baseUrl}?key=${encodeURIComponent(steamKey)}&filter=${encodeURIComponent(filterString)}&limit=${limit}`;
    log(`使用 Steam Web API 查询 APPID ${appId} 的服务器列表（filter=${filterString}，limit=${limit}）`);
    // 简单重试策略（指数回退）
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
          // 403 说明 key 权限/partner/publisher host 等问题；记录并退出（不要不停重试 403）
          if (resp.status === 403) {
            log(`Steam Web API 返回 403（可能需要 publisher key 或账号权限），停止使用 Web API：HTTP 403`);
            lastErr = new Error('Steam Web API 403 Forbidden');
            break;
          }
          const text = await resp.text().catch(()=>'<no-body>');
          lastErr = new Error(`Steam Web API HTTP ${resp.status} - ${text}`);
          log(`Steam Web API 返回 HTTP ${resp.status}，尝试重试（${attempt}/${maxAttempts}）: ${text}`);
          // 对 5xx 或 429 做重试
          if (resp.status >= 500 || resp.status === 429) {
            await new Promise(r => setTimeout(r, 1000 * attempt));
            continue;
          } else {
            break;
          }
        }

        const data = await resp.json();
        // 期望结构： { response: { servers: [ { addr: '1.2.3.4:27015', ... }, ... ] } }
        if (!data || !data.response) {
          log(`Steam Web API 返回格式异常，response 字段缺失，内容: ${JSON.stringify(data).slice(0,300)}`);
          return [];
        }
        const servers = data.response.servers || [];
        log(`Steam Web API 返回 ${servers.length} 台服务器（APPID ${appId}）`);
        // 将 addr 转成 {ip, port}
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
        // 如果是中止/超时，短暂等待再重试
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
    // 如果重试穷尽仍然失败
    if (lastErr) {
      log(`Steam Web API 调用最终失败: ${lastErr.message}`);
    }
    // 如果到这里没有返回（比如 403），降级到 UDP 原方法（但可能会被 Valve 限制）
    log('尝试降级：如果你仍然需要通过匿名 UDP master 查询，请确认 Valve 没有对该 APPID 限制。降级可能也会失败或被 rate-limited。');
  } else {
    log('未配置 STEAM_API_KEY，无法使用 Steam Web API 获取服务器列表；将尝试匿名 UDP 查询（可能已被 Valve 限制/拒绝）');
  }

  // 如果没有 STEAM_API_KEY 或 Web API 失败，我们继续用原来的 UDP master 查询（可能会 timeout）
  // 这里我们保留一个更稳健的 UDP 查询备选实现：使用本地 socket 循环读取直到结束（使用第三方库通常更稳定）
  // 简化实现：调用原先 queryMasterServer（如果你安装了 steam-server-query 并允许 UDP）
  try {
    // 尝试动态加载 steam-server-query（如果存在）
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

// 新增：获取本地日期字符串（修复时区问题）
function getLocalDateString() {
  const now = new Date();
  // 使用本地时间而不是UTC时间
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 新增：检查是否需要重置历史数据（新的一天）
function checkAndResetHistoryIfNewDay() {
  const today = getLocalDateString();
  
  // 如果是新的一天，重置lastHistoryDate并记录日志
  if (lastHistoryDate !== today) {
    log(`检测到新的一天: ${lastHistoryDate || '无记录'} -> ${today}`);
    lastHistoryDate = today;
    return true;
  }
  
  return false;
}

// 新增：更新服务器历史数据
async function updateServerHistory(serverInfo) {
  try {
    const key = `${serverInfo.ip}:${serverInfo.port}`;
    const today = getLocalDateString(); // 使用本地日期
    
    // 检查服务器标识是否改变
    if (serverHistory[key]) {
      const history = serverHistory[key];
      if (history.name !== serverInfo.name || 
          history.ip !== serverInfo.ip || 
          history.port !== serverInfo.port) {
        // 服务器标识已改变，重置历史数据
        log(`服务器标识已改变，重置历史数据: ${key}`);
        serverHistory[key] = {
          name: serverInfo.name,
          ip: serverInfo.ip,
          port: serverInfo.port,
          history: {}
        };
      }
    } else {
      // 新服务器，初始化历史数据
      serverHistory[key] = {
        name: serverInfo.name,
        ip: serverInfo.ip,
        port: serverInfo.port,
        history: {}
      };
    }
    
    // 更新今天的在线人数（取最大值）
    const serverData = serverHistory[key];
    if (!serverData.history[today] || serverInfo.current_players > serverData.history[today]) {
      serverData.history[today] = serverInfo.current_players;
      log(`更新服务器历史数据: ${key} - ${today}: ${serverInfo.current_players} 玩家`);
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

    const results = await asyncPool(keys, CONCURRENCY, async (key) => {
      const server = serverMap.get(key);
      const [ip, portStr] = key.split(':');
      const port = parseInt(portStr);
      const info = await queryServerInfo(ip, port);
      if (info) {
        const geo = await getGeoInfo(ip);
        const data = { ...info, ...geo, offline: false };
        server.lastData = data;
        server.failureCount = 0;
        server.lastSuccessful = Date.now();
        
        // 新增：更新服务器历史数据
        await updateServerHistory(data);
        
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
    log(`推送了 ${pushDatas.length} 个服务器更新到 ${clients.size} 个客户端`);
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

// 启动 HTTPS (并可选启动 HTTP 重定向) 的异步初始化
async function startServersAndServices() {
  // 检查 pfx 文件是否存在并读取
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
    // 如果 passphrase 是 undefined 且 pfx 没有密码，Node 会自动处理；如果 pfx 有密码且未提供，会报错
    passphrase: pfxPassphrase
  };

  // 创建 HTTPS server
  const httpsServer = https.createServer(httpsOptions, app);

  // WebSocket 将挂载在 httpsServer 上
  wss = new WebSocket.Server({ server: httpsServer, path: '/ws' });

  // WebSocket 连接处理（你原来的逻辑）
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

  // 可选：启动 HTTP 服务，用于重定向到 HTTPS
  let httpServer = null;
  if (enableHttpRedirect) {
    httpServer = http.createServer((req, res) => {
      // 构造跳转到 https 的 Location（保留 host，但替换端口为 httpsPort 如果必要）
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

  // 启动监听
  httpsServer.listen(httpsPort, '0.0.0.0', () => {
    log(`HTTPS 服务器运行在 https://0.0.0.0:${httpsPort}`);
    log(`WebSocket 服务器运行在 wss://0.0.0.0:${httpsPort}/ws`);
  });

  if (enableHttpRedirect && httpServer) {
    httpServer.listen(httpPort, '0.0.0.0', () => {
      log(`HTTP 重定向服务器运行在 http://0.0.0.0:${httpPort} (重定向到 HTTPS)`);
    });
  }

  // 以下保持原逻辑：初始化文件、定时任务等
  try {
    await Promise.all([initializeGeoCacheFile(), initializeServerListFile(), initializeServerHistoryFile()]);
  } catch (err) {
    log(`初始化文件失败: ${err.message}`);
    // 继续也许可以运行，但提醒
  }

  // 初始化lastHistoryDate
  lastHistoryDate = getLocalDateString();
  log(`当前日期: ${lastHistoryDate}`);

  // 立即清理一次
  await cleanServerList();

  // 使用解析后的 UpdateServerIPsTimeMs / UpdateServerInfoTimeMs
  setInterval(updateServerIPs, UpdateServerIPsTimeMs); // 每 UpdateServerIPsTimeMs ms 更新一次
  setInterval(updateServerInfo, UpdateServerInfoTimeMs); // 每 UpdateServerInfoTimeMs ms 更新一次
  setInterval(cleanServerList, 3600000); // 每小时检查清理一次

  // 立即触发一次
  updateServerIPs();
  updateServerInfo();
}

// express 路由（保持不变）
app.get('/api/servers', async (req, res) => {
  log('收到 /api/servers 请求');
  res.json({ message: '服务器列表已通过 WebSocket 推送' });
});

// 新增：获取服务器历史数据的API端点
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

// 安全修复：阻止访问敏感文件
app.use((req, res, next) => {
  const blockedFiles = ['API_TOKEN.json', 'geo_cache.json', 'server_list.json', 'server_history.json', 'app_id.json', 'your_domain.pfx'];
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