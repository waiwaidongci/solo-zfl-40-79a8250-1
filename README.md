# 古法蓝晒底片批次工作台

一次曝光拆分为多块底片,记录药液批次、曝光时间与冲洗水源;底片按
`待曝光 → 冲洗中 → 待入盒 → 已交付` 依次推进,退回与跳步一律拒绝。

## 运行

```bash
npm start          # http://localhost:3040
```

数据保存在 `data/cyanotype-negative-room.json`。启动时会真实写入探针文件确认数据目录可写,不可写则拒绝启动;落盘采用临时文件 + fsync + rename + 目录 fsync,断电或中断不会留下半截数据,重启时自动清理残留临时文件并迁移旧格式数据。

## 运行保障

- **健康检查**:`GET /api/health` 返回版本、监听地址、数据库可读状态与未关闭工单数;数据库不可读时返回 503 与 `degraded`。
- **优雅退出**:收到 `SIGTERM`/`SIGINT` 后停止接收新连接,等待在途请求与排队写入全部落盘后退出(超时 5 秒强制退出)。
- **请求日志**:每行带请求编号(响应头 `X-Request-Id` 一致)、方法、路径、响应状态与耗时;仅记录 `to`/`box`/`expectedVersion`/`count`/`status` 等操作类字段,复核人、结论、处理结果、备注等敏感内容一律不落地,查询串也不记录。

## 测试

```bash
npm test           # node --test,自动发现 test/ 下全部用例(兼容新旧 Node;不要写成 node --test test/,新版 Node 会把目录当成模块)
```

覆盖状态机、盒位冲突、幂等重放、重启恢复、异常输入、并发更新,以及测试命令本身的回归检查(命令漂移、失败时退出码非零)。

## 业务规则

- **批次拆分**:`POST /api/batches` 传入 `chemicalBatch`、`exposure`、`waterSource`、`count`,一次创建 1-100 块底片,编号 `PC-0001-01` 起。
- **状态机**:仅允许依次推进;入盒(`待入盒`)必须指定盒位;同一盒位不能同时存放两块未交付底片,交付后盒位自动释放。
- **工艺步骤**:`POST /api/items/:id/steps` 记录步骤,复晒(`reexpose`)、缺陷、修补均关联到具体步骤与当时状态;已交付底片拒绝追加。
- **复核工单**:底片进入 `待入盒` 后可发起复核(`POST /api/items/:id/reviews`),记录复核人、缺陷结论、整改要求、截止时间;存在未关闭工单时底片不能交付;同一盒位任一时刻只能有一张未关闭工单;关闭工单(`POST /api/reviews/:id/close`)必须填写处理结果;逾期工单在列表(`overdue` 标记)与统计(`reviews.overdue`)中单独标出。截止时间只接受真实存在的日历日期(`YYYY-MM-DD`,按当日结束计)或合法 ISO 时间,不存在的日期(如 2026-02-31)与时间会被 400 拒绝,不会滚入相邻月份。
- **幂等**:写操作支持 `Idempotency-Key` 请求头(或 `requestId` 字段),重复提交返回首次结果(`X-Idempotent-Replay: true`),不产生重复记录;同键不同内容返回 409。
- **失败回滚**:变更采用"改内存 + 落盘"串行执行,落盘失败时整体回滚内存记录、幂等键与序号,文件保持原内容;同一幂等键可安全重试,失败记录不会被后续写入意外持久化。
- **并发**:更新可携带 `expectedVersion` 做乐观锁,版本不匹配返回 409;并发推进/抢占盒位/发起或关闭工单只有一个请求成功。
- **筛选与统计**:`GET /api/items?status=&batch=&box=&defect=&q=`,`GET /api/reviews?status=&box=&item=&overdue=`,`GET /api/stats` 实时从当前记录计算。

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 工作台页面 |
| POST | `/api/batches` | 创建曝光批次并拆分底片 |
| GET | `/api/batches` | 批次列表 |
| GET | `/api/items` | 底片列表(支持筛选) |
| GET | `/api/items/:id` | 单块底片详情 |
| POST | `/api/items/:id/transition` | 状态推进 `{ to, box?, expectedVersion? }` |
| POST | `/api/items/:id/steps` | 记录工艺步骤 `{ step, developStatus?, defect?, repair?, reexpose?, note? }` |
| POST | `/api/items/:id/reviews` | 发起复核工单 `{ reviewer, conclusion, requirement, deadline }` |
| GET | `/api/reviews` | 工单列表(支持 status/box/item/overdue 筛选,含逾期标记) |
| POST | `/api/reviews/:id/close` | 关闭工单 `{ resolution, expectedVersion? }` |
| GET | `/api/stats` | 状态/缺陷/复晒/工单统计 |
| GET | `/api/health` | 健康检查(版本/监听地址/数据库可读/未关闭工单数) |

错误统一返回 `{ "error": 错误码, "message": 描述 }`,状态码语义:400 输入非法 / 404 不存在 / 405 方法不允许 / 409 业务冲突(跳步、退回、盒位占用、版本冲突、幂等键重用)/ 413 请求体过大。
