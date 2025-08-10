const express = require('express'); 
const fetch = require('node-fetch').default;
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
const Query = require('source-server-query');
const { queryMasterServer, REGIONS } = require('steam-server-query');

const app = express();

// -----------------------------
// 启动参数解析（大小写不敏感、优雅降级）
// 支持形式：--port=3000  或  --PORT=3000  或  --port 3000
// 支持时间参数单位： "30s" (秒), "30000ms" (毫秒)，对于 UpdateServer* 默认把裸数字当作 秒；
// 对于 INFO_TIMEOUT 裸数字当作 毫秒。
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
            // 如果下一个参数存在且不是以 -- 开头，就认为它是值
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

// 默认值（保留原始默认，但改为 let 以便用启动项覆盖）
let port = 80;
let CONCURRENCY = 10;      // 并发上限（根据机器能力调节；测试时可降到 5/10）
let INFO_TIMEOUT = 2000;  // ms，用于 Query.info 的超时
let UpdateServerIPsTimeMs = 600 * 1000; // 默认 600 秒 -> ms
let UpdateServerInfoTimeMs = 30 * 1000; // 默认 30 秒 -> ms

// 从 rawArgs 中读取并校验
try {
    if (rawArgs.port !== undefined) {
        const p = toInt(rawArgs.port, null);
        if (p && p > 0 && p < 65536) {
            port = p;
        } else {
            console.warn(`[WARN] 无效的 port 值 "${rawArgs.port}"，使用默认 port=${port}`);
        }
    }

    // concurrency
    if (rawArgs.concurrency !== undefined) {
        const c = toInt(rawArgs.concurrency, null);
        if (c && c > 0) {
            CONCURRENCY = c;
        } else {
            console.warn(`[WARN] 无效的 CONCURRENCY 值 "${rawArgs.concurrency}"，使用默认 CONCURRENCY=${CONCURRENCY}`);
        }
    } else if (rawArgs['concurrency'] === undefined && rawArgs['CONCURRENCY'] !== undefined) {
        // should be covered, kept for clarity
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
    } else if (rawArgs.updateserveripstime !== undefined) {
        // no-op, kept for symmetry
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

    // Also support uppercase keys (because parse normalized to lowercase, this is redundant but safe)
    if (rawArgs['concurrency'] === undefined && rawArgs['CONCURRENCY'] !== undefined) {
        const c = toInt(rawArgs['CONCURRENCY'], null);
        if (c && c > 0) CONCURRENCY = c;
    }
} catch (e) {
    console.warn('[WARN] 解析启动参数时发生异常，使用全部默认配置：', e && e.message ? e.message : e);
}

// 打印最终使用的配置
function logStartConfig() {
    console.log('------------------ 启动配置 ------------------');
    console.log(`PORT: ${port}`);
    console.log(`CONCURRENCY: ${CONCURRENCY}`);
    console.log(`INFO_TIMEOUT: ${INFO_TIMEOUT} ms`);
    console.log(`UpdateServerIPsTime: ${Math.floor(UpdateServerIPsTimeMs / 1000)} s (${UpdateServerIPsTimeMs} ms)`);
    console.log(`UpdateServerInfoTime: ${Math.floor(UpdateServerInfoTimeMs / 1000)} s (${UpdateServerInfoTimeMs} ms)`);
    console.log('------------------------------------------------');
}
logStartConfig();

// -----------------------------
// 下面是你原有的逻辑（尽量保持不变）
// -----------------------------

const server = app.listen(port, '0.0.0.0', () => {
    log(`HTTP 服务器运行在 http://0.0.0.0:${port}`);
    log(`WebSocket 服务器运行在 ws://0.0.0.0:${port}/ws`);
});
const wss = new WebSocket.Server({ server, path: '/ws' });

const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');
const SERVER_LIST_FILE = path.join(__dirname, 'server_list.json');
const TOKEN_FILE = path.join(__dirname, 'API_TOKEN.json');
const APP_ID_FILE = path.join(__dirname, 'app_id.json');

// 可调参数
// 已通过上面的解析覆盖 CONCURRENCY 和 INFO_TIMEOUT

let clients = new Set();
let geoCache = {};
let serverIPs = new Set();
let serverDataCache = [];
let isUpdatingServerInfo = false;

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

wss.on('connection', (ws) => {
    clients.add(ws);
    log('新客户端已连接');
    broadcastVisitorCount();

    if (serverDataCache.length > 0) {
        log('向新客户端推送缓存的服务器数据');
        serverDataCache.forEach(serverData => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(serializeBigInt(serverData));
            }
        });
    } else {
        log('缓存为空，等待下一次服务器数据更新');
    }

    ws.on('close', () => {
        clients.delete(ws);
        log('客户端已断开');
        broadcastVisitorCount();
    });
});

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
            serverIPs = new Set(servers.map(s => `${s.ip}:${s.port}`));
            log(`成功加载服务器列表，包含 ${serverIPs.size} 个服务器`);
        } else {
            log('server_list.json 为空，初始化为空数组');
            serverIPs = new Set();
        }
    } catch (err) {
        if (err.code === 'ENOENT') {
            log('server_list.json 不存在，正在创建...');
            await fs.writeFile(SERVER_LIST_FILE, JSON.stringify([], null, 2), 'utf8');
            serverIPs = new Set();
            log('server_list.json 创建成功');
        } else {
            log(`检查或读取 server_list.json 失败: ${err.message}`);
            serverIPs = new Set();
        }
    }
}

async function loadToken() {
    try {
        const data = await fs.readFile(TOKEN_FILE, 'utf8');
        const tokens = JSON.parse(data);
        if (!tokens.IPINFO_TOKEN) throw new Error('IPINFO_TOKEN 未定义');
        return tokens.IPINFO_TOKEN;
    } catch (err) {
        log(`读取 API_TOKEN.json 失败: ${err.message}`);
        throw new Error('无法加载 API token，请确保 API_TOKEN.json 存在并包含有效的 IPINFO_TOKEN');
    }
}

/**
 * 使用 source-server-query 的 Query.info/players（稳定）
 * 只把 Query.info 的往返时间作为 latency（ping）
 * 使用 process.hrtime.bigint() 精确计时
 */
async function queryServerInfo(ip, port) {
    try {
        log(`开始查询服务器信息: ${ip}:${port}`);

        const infoStart = process.hrtime.bigint();
        const serverInfo = await Query.info(ip, port, INFO_TIMEOUT);
        const infoEnd = process.hrtime.bigint();

        if (!serverInfo) {
            log(`服务器信息为空 (${ip}:${port})`);
            return null;
        }

        const latency = Number((infoEnd - infoStart) / 1000000n); // ms
        log(`A2S_INFO 延迟 (${ip}:${port}): ${latency} ms`);
        log(`收到服务器信息字段 (${ip}:${port}): ${Object.keys(serverInfo).join(', ')}`);

        // players 单独查询，不计入 latency
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
                // 有些实现返回对象或空，忽略但记录日志
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
        log(`服务器查询失败 (${ip}:${port}): ${err.message}`);
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
        const IPINFO_TOKEN = await loadToken();
        log(`查询地理信息: ${ip}`);
        const response = await fetch(`https://ipinfo.io/${ip}?token=${IPINFO_TOKEN}`, { timeout: 5000 });
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

async function getMasterServerList(appId, filter = {}) {
    const masterServerAddress = 'hl2master.steampowered.com:27011';
    const region = REGIONS.ALL;
    const filterOptions = { appid: appId, ...filter };

    try {
        log(`开始查询 APPID ${appId} 的服务器列表${filter ? '，过滤条件: ' + JSON.stringify(filter) : ''}`);
        const servers = await queryMasterServer(masterServerAddress, region, filterOptions);
        log(`收到 APPID ${appId} 的服务器列表，数量: ${servers.length}`);
        return servers.map(server => {
            const [ip, port] = server.split(':');
            return { ip, port: parseInt(port), appId };
        });
    } catch (err) {
        log(`查询 APPID ${appId} 的服务器列表失败: ${err.message}`);
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
    
    const uniqueNewServers = newServers.filter(server => !serverIPs.has(`${server.ip}:${server.port}`));
    if (uniqueNewServers.length > 0) {
        const allServers = [
            ...Array.from(serverIPs).map(key => {
                const [ip, port] = key.split(':');
                return { ip, port: parseInt(port) };
            }),
            ...uniqueNewServers
        ];
        await fs.writeFile(SERVER_LIST_FILE, JSON.stringify(allServers, null, 2), 'utf8');
        uniqueNewServers.forEach(server => serverIPs.add(`${server.ip}:${server.port}`));
        log(`新增 ${uniqueNewServers.length} 个服务器IP到 server_list.json`);
    } else {
        log('没有新的服务器IP');
    }
}

async function updateServerInfo() {
    if (isUpdatingServerInfo) {
        log('上一次更新仍在进行中，跳过本次执行');
        return;
    }
    isUpdatingServerInfo = true;

    try {
        const servers = JSON.parse(await fs.readFile(SERVER_LIST_FILE, 'utf8'));
        log(`开始并发查询 ${servers.length} 台服务器信息（并发上限 ${CONCURRENCY}）`);

        const results = await asyncPool(servers, CONCURRENCY, async (server) => {
            const info = await queryServerInfo(server.ip, server.port);
            if (!info) return null;
            const geoInfo = await getGeoInfo(server.ip);
            return { ...info, ...geoInfo };
        });

        serverDataCache = results.filter(r => r !== null);
        log(`更新服务器数据缓存，包含 ${serverDataCache.length} 个有效服务器`);

        // 推送所有服务器信息到客户端（每一条）
        serverDataCache.forEach(serverData => {
            clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(serializeBigInt(serverData));
                }
            });
        });
        log(`推送了 ${serverDataCache.length} 个服务器信息到 ${clients.size} 个客户端`);
        broadcastVisitorCount();
    } catch (err) {
        log(`更新服务器信息失败: ${err.message}`);
    } finally {
        isUpdatingServerInfo = false;
    }
}

Promise.all([initializeGeoCacheFile(), initializeServerListFile()]).then(() => {
    // 使用解析后的 UpdateServerIPsTimeMs / UpdateServerInfoTimeMs
    setInterval(updateServerIPs, UpdateServerIPsTimeMs); // 每 UpdateServerIPsTimeMs ms 更新一次
    setInterval(updateServerInfo, UpdateServerInfoTimeMs); // 每 UpdateServerInfoTimeMs ms 更新一次
    updateServerIPs();
    updateServerInfo();
});

app.get('/api/servers', async (req, res) => {
    log('收到 /api/servers 请求');
    res.json({ message: '服务器列表已通过 WebSocket 推送' });
});

app.use(express.static(__dirname));
