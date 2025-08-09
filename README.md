# Steam-Server-Web-Browser

<img width="1896" height="879" alt="image" src="https://github.com/user-attachments/assets/36ab514f-fa75-40db-984f-a57a91cf24c1" />

## 使用方法

- 配置运行环境（适用于全新部署）
```bash
npm install dgram express node-fetch source-server-query steam-server-query ws
```

- 编辑 `API_TOKEN.json`（填入你的 [ipinfo.io](https://ipinfo.io) Token）
```json
{
    "IPINFO_TOKEN": "YOUR_KEY"
}
```

- 编辑 app_id.json（填入要查询的 Steam 游戏 App ID）

```json
[
    1088090,
    2520410,
    1295900
]  
```

- 启动服务

```bash
node server.js
```
