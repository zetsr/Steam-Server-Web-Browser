const express = require('express');
const fetch = require('node-fetch').default;
const fs = require('fs').promises;
const path = require('path');
const WebSocket = require('ws');
const Query = require('source-server-query');
const { queryMasterServer, REGIONS } = require('steam-server-query');

const app = express();
const port = 80;
const server = app.listen(port, '0.0.0.0', () => {
    log(`HTTP 服务器运行在 http://0.0.0.0:${port}`);
    log(`WebSocket 服务器运行在 ws://0.0.0.0:${port}/ws`);
});
const wss = new WebSocket.Server({ server, path: '/ws' });
const GEO_CACHE_FILE = path.join(__dirname, 'geo_cache.json');
const SERVER_LIST_FILE = path.join(__dirname, 'server_list.json');
const TOKEN_FILE = path.join(__dirname, 'API_TOKEN.json');
const APP_ID_FILE = path.join(__dirname, 'app_id.json');

let clients = new Set();
let geoCache = {};
let serverIPs = new Set();
let serverDataCache = [];

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

async function queryServerInfo(ip, port) {
    try {
        const startTime = Date.now();
        log(`开始查询服务器信息: ${ip}:${port}`);

        const serverInfo = await Query.info(ip, port, 10000);
        if (!serverInfo) {
            log(`服务器信息为空 (${ip}:${port})`);
            return null;
        }
        log(`收到服务器信息字段 (${ip}:${port}): ${Object.keys(serverInfo).join(', ')}`);
        log(`收到服务器信息 (${ip}:${port}): ${serializeBigInt(serverInfo)}`);

        let players = [];
        try {
            const playerData = await Query.players(ip, port, 10000);
            log(`收到玩家列表 (${ip}:${port}): ${serializeBigInt(playerData)}`);
            players = playerData.map(player => ({
                name: player.name || '未知',
                score: player.score >= 0 ? `+${player.score}` : `${player.score}`,
                duration: formatDuration(player.duration)
            }));
        } catch (err) {
            log(`玩家列表查询失败 (${ip}:${port}): ${err.message}`);
        }

        const latency = Math.round(Date.now() - startTime);
        const rawMaxPlayers = serverInfo.maxPlayers || serverInfo.max_players || 0;
        const max_players = rawMaxPlayers < 0 ? rawMaxPlayers + 256 : rawMaxPlayers;
        const info = {
            ip,
            port,
            game_description: serverInfo.game || '未知',
            name: serverInfo.name || '未知',
            map: serverInfo.map || '未知',
            version: serverInfo.version || '未知',
            current_players: serverInfo.players || 0,
            max_players,
            os: serverInfo.environment === 'l' ? 'Linux' :
                serverInfo.environment === 'w' ? 'Windows' :
                serverInfo.environment === 'm' ? 'macOS' : '未知',
            players,
            latency
        };
        log(`返回服务器信息 (${ip}:${port}): current_players=${info.current_players}, max_players=${info.max_players}`);
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
            isp: data.org ? data.org.split(' ').slice(1).join(' ') : '未知'
        };
        
        geoCache[ip] = geoInfo;
        await saveGeoCache();
        return geoInfo;
    } catch (err) {
        log(`地理信息查询失败 (${ip}): ${err.message}`);
        return { country: 'unknown', isp: '未知' };
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
    const servers = JSON.parse(await fs.readFile(SERVER_LIST_FILE, 'utf8'));
    log(`开始并发查询 ${servers.length} 台服务器信息`);
    const promises = servers.map(async server => {
        const info = await queryServerInfo(server.ip, server.port);
        if (info) {
            const geoInfo = await getGeoInfo(server.ip);
            return { ...info, ...geoInfo };
        }
        return null;
    });

    const results = await Promise.all(promises);
    serverDataCache = results.filter(r => r !== null);
    log(`更新服务器数据缓存，包含 ${serverDataCache.length} 个有效服务器`);

    serverDataCache.forEach(serverData => {
        clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(serializeBigInt(serverData));
            }
        });
    });
    log(`推送了 ${serverDataCache.length} 个服务器信息到 ${clients.size} 个客户端`);
    broadcastVisitorCount();
}

Promise.all([initializeGeoCacheFile(), initializeServerListFile()]).then(() => {
    setInterval(updateServerIPs, 60 * 1000);
    setInterval(updateServerInfo, 10 * 1000);
    updateServerIPs();
    updateServerInfo();
});

app.get('/api/servers', async (req, res) => {
    log('收到 /api/servers 请求');
    res.json({ message: '服务器列表已通过 WebSocket 推送' });
});

app.use(express.static(__dirname));