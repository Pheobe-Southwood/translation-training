# 部署与 HTTPS 运维说明

> 站点：`cgxyserver.top` ｜ 主机：vrc-vps（`103.236.54.189`）｜ 更新：2026-10-29
> 本文只记录运行机制与操作命令，不包含备案号、邮箱、密钥等运行时配置。

## 一、拓扑

```
互联网
  │
  ├── :80  nginx ──┬─ /.well-known/acme-challenge/ → /var/www/certbot（证书签发）
  │                └─ 其他 → 301 https://$host
  │
  └── :443 nginx ──┬─ SNI = cgxyserver.top / www  → 反代 127.0.0.1:8888（Node 应用）
                   └─ 无 SNI / 裸 IP             → 反代 127.0.0.1:4443（DERP，明文 HTTP）

Node 应用 127.0.0.1:8888（Fastify + WebSocket /ws）
DERP      :4443（明文，仅本机可达）＋ UDP :3478（STUN，公网）
```

- 关闭了 `8888` 的公网访问，所有流量必须经 nginx。
- DERP 的 TLS 由 nginx 终止：裸 IP 访问使用 **IP 证书**，DERP 客户端不发送 SNI，正好落到默认 server 块。
- 应用通过 `X-Forwarded-Proto: https` 判断协议并下发 HSTS，通过 `X-Forwarded-For` 取真实 IP。

## 二、DNS

在阿里云云解析（NS：`dns9/dns10.hichina.com`）添加：

| 类型 | 主机记录 | 值 | TTL |
| --- | --- | --- | --- |
| A | `@` | `103.236.54.189` | 600 |
| A | `www` | `103.236.54.189` | 600 |

不要开启 CDN、代理或境外加速，否则 443 不会落到本机，证书与 DERP 都会异常。

## 三、文件清单

| 路径 | 作用 |
| --- | --- |
| `/etc/nginx/conf.d/cgxyserver.conf` | 80/443 三个 server 块、日志格式、反代与 WebSocket |
| `/etc/nginx/ssl/` | 初始自签证书（仅应急回滚，可保留） |
| `/var/www/certbot/` | ACME HTTP-01 webroot |
| `/etc/systemd/system/derper.service.d/10-behind-nginx.conf` | DERP 改为 `-a :4443`，由 nginx 代理 |
| `/opt/certbot-venv/` | certbot 5.8（支持 IP 证书与 `shortlived` profile） |
| `/etc/cron.d/certbot-renew` | 每天 03:17 / 15:17 续期并 reload nginx |
| `/var/log/nginx/cgxyserver.access.log` | 站点访问日志（JSON，180 天轮转） |
| `/var/log/nginx/derp.access.log` | DERP 访问日志 |
| `/var/www/translation-training/.env` | 运行时配置（备案号、邮箱、AUTH_SECRET 等，不入库） |

## 四、证书体系

两套证书，**不要混用**：

| 证书 | 标识 | 有效期 | 用途 |
| --- | --- | --- | --- |
| 域名证书 | `cgxyserver.top`（SAN 含 `www`） | 90 天 | 网站 443 |
| IP 证书 | `ip-103.236.54.189` | 约 6 天（`shortlived`） | 裸 IP 访问 DERP 时的 TLS |

签发与续期统一使用 venv 中的 certbot 5.8：

```bash
# 域名证书（有效期 90 天）
/opt/certbot-venv/bin/certbot certonly --webroot -w /var/www/certbot \
  -d cgxyserver.top -d www.cgxyserver.top \
  --non-interactive --agree-tos -m <你的邮箱> \
  --deploy-hook "systemctl reload nginx"

# IP 证书（有效期约 6 天，必须带 shortlived）
/opt/certbot-venv/bin/certbot certonly --webroot -w /var/www/certbot \
  --ip-address 103.236.54.189 --preferred-profile shortlived \
  --cert-name ip-103.236.54.189 \
  --non-interactive --agree-tos -m <你的邮箱> \
  --deploy-hook "systemctl reload nginx"
```

续期检查：

```bash
/opt/certbot-venv/bin/certbot renew --dry-run
certbot certificates          # 系统自带 2.9 也可只读查看
```

> **不要重新启用系统 `certbot.timer`**。Ubuntu 自带的 certbot 2.9 不支持 IP 证书与
> `shortlived` profile，会让 IP 证书续期失败。当前已 `systemctl disable --now certbot.timer`，
> 续期由 `/etc/cron.d/certbot-renew` 调用 venv 版本完成。

## 五、DERP 说明

- 服务单元：`derper.service`，监听 `:4443`（HTTP）与 `:3478/udp`（STUN）。
- Tailscale 的 DERP map（region `vpscn`）中 `HostName` 仍是 `103.236.54.189`、`DERPPort` 仍是 `443`，因此客户端始终拨 `https://103.236.54.189/derp`。
- nginx 默认 443 server 使用 IP 证书终止 TLS，再以明文 HTTP 反代到 `127.0.0.1:4443`。
- 副作用：derper 看到的客户端 IP 均为 `127.0.0.1`，仅影响其按 IP 的限速统计，不影响中继。
- 验证：

```bash
curl -sk -o /dev/null -w '%{http_code}\n' https://103.236.54.189/derp \
  -H 'Upgrade: DERP' -H 'Connection: Upgrade'      # 期望 101
tailscale netcheck | grep -A2 'DERP latency'       # vpscn 应为毫秒级
```

## 六、日志与留存

| 日志 | 位置 | 留存 |
| --- | --- | --- |
| 站点访问 | `/var/log/nginx/cgxyserver.access.log` | 180 天（`/etc/logrotate.d/nginx`） |
| DERP | `/var/log/nginx/derp.access.log` | 180 天 |
| 应用访问/审计 | journald | `Storage=persistent`、`SystemMaxUse=4G`、`MaxRetentionSec=1year` |
| 证书续期 | `/var/log/certbot-renew.log` | 随系统 |

访问日志使用 `$uri` 而非 `$request_uri`，不会记录观战链接中的 `t=` 票据。

## 七、常用命令

```bash
systemctl status nginx translation-training derper
journalctl -u translation-training -f
tail -f /var/log/nginx/cgxyserver.access.log
nginx -t && systemctl reload nginx
curl -sI https://cgxyserver.top | head
```

## 八、回滚

1. 恢复 DERP：删除 `/etc/systemd/system/derper.service.d/10-behind-nginx.conf`，
   `systemctl daemon-reload && systemctl restart derper`（回到 `-a :443`，需先停 nginx 或改端口）。
2. 恢复 nginx：使用 `/etc/nginx/nginx.conf.bak.20261029T111825Z` 与
   `/etc/systemd/system/derper.service.bak.20261029T111825Z`。
3. 应急证书：`/etc/nginx/ssl/cgxyserver.top.{crt,key}` 为自签证书，可临时改回以恢复服务。
4. 应用回滚：CI 部署脚本在健康检查失败时会自动回滚 `dist`；也可手动恢复 `dist.old.*`。

## 九、注意事项

- 不要删除 `/opt/certbot-venv`，否则 IP 证书无法续期（6 天后 DERP 证书过期）。
- 不要把 443 的默认 server 改成 `return 444`，否则 DERP 客户端会握手失败。
- 不要给 443 开启 HTTP/2：DERP 依赖 HTTP/1.1 的 `Upgrade: DERP`，实测 h2 会返回 426。
- 修改 `.env` 后需 `systemctl restart translation-training`；nginx 配置改动后 `nginx -t` 再 reload。
- 备案号、联系邮箱只存在于服务器 `.env`，不要提交到仓库。
