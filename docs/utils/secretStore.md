# SecretStore 凭据加密存储

> 源码 [src/utils/secretStore.ts](../../src/utils/secretStore.ts) ｜ 上级 [README](./README.md) ｜ 相关 [../agent/plugin.md](../agent/plugin.md)

## 职责

`secretStore` 是 utils 层的**凭据池加密后端**：为 plugins/skills/未来 commands 模块提供 GitHub 等私有仓的「用户名 + 密令（password / token）」加密存储 + CRUD。**只服务后端进程**，密令**永不回前端**（list 只返 id/label/username）。

定位：

- **不是** OS keychain / DPAPI / Keychain 集成。
- **是** 「文件 + 派生密钥」的 obfuscation 级加密存储，满足「不以明文落盘」承诺。
- **升级路径**：Electron `safeStorage`（当前未接，后端为独立 Node 子进程无法直连主进程 API）。

## 加密方案

| 组件 | 实现 | 说明 |
|------|------|------|
| 算法 | AES-256-GCM（`node:crypto`） | 提供 confidentiality + 完整性（authTag 防篡改） |
| 主密钥 | `.chery/.secret-key` | 32 随机字节（`crypto.randomBytes(32)`），**0600** 权限，首用按需生成 |
| cipher key 派生 | `scrypt(masterKey, salt, 32)` | salt = `${hostname}|${username}`（机器维度绑定，移植到其它机器密文不可解） |
| IV | 12 字节随机（`crypto.randomBytes(12)`） | 每条密文独立 IV（GCM 标准） |
| authTag | GCM 自带（16 字节） | 解密时校验，密文或 IV 被改 → 抛错（fail loud） |

**为什么 scrypt 派生而非直接用 masterKey**：绑定 hostname + username 让单机偷走密文+主密钥仍需在同一机器才能解（缓解「备份被偷」场景），并解耦密钥轮换（未来可改 salt 维度而不动 masterKey）。

```ts
// 核心加解密（纯函数，无文件依赖）
export function encryptString(plain: string): {ciphertext: string; iv: string; tag: string};
//   └─ 读 masterKey → scrypt 派生 → randomBytes(12) IV → createCipheriv("aes-256-gcm") → 
//      update/final → 得 ciphertext + tag，全 base64

export function decryptString(ciphertext: string, iv: string, tag: string): string;
//   └─ 读 masterKey → scrypt 派生 → createDecipheriv → setAuthTag(tag) → update/final
//        └─ tag 不匹配 / 密钥错误 → 抛错（fail loud，不返空串伪装成功）
```

## 存储

文件：`.chery/.secrets/git-credentials.json`

- **0600 权限**，**原子写**（`tmp + rename`，防半写文件导致 JSON 解析失败）。
- 路径不进 sqlite（避免触碰 better-sqlite3 ABI 跨进程兼容问题）。
- 数组结构，每项一条凭据：

```ts
interface StoredCredential {
  id: string;            // UUID v4（前端下拉 key）
  label: string;         // 用户起的别名（如 "个人 PAT"）
  username: string;      // GitHub 用户名 / token 占位（明文存，非敏感）
  ciphertext: string;    // 密令密文（base64）
  iv: string;            // 12 字节 IV（base64）
  tag: string;           // GCM authTag（base64）
  createdAt: number;     // 创建时间戳（ms）
}
```

> `username` 明文存——它对 GitHub basic auth 是非敏感的「标识符」（敏感部分是 password/token）。如果你仍然希望 username 不外露，前端 list 已仅返 `username`（不返 ciphertext），UI 默认显示 `label`。

## API

```ts
// CRUD（service/credentials/handler.ts 包装为 RPC）
export function listCredentials(): CredentialListItem[];
//   └─ 只返 {id, label, username}（密令永不外露）

export function getCredentialSecret(id: string): string;
//   └─ 仅后端调用：读 ciphertext/iv/tag → decryptString
//        └─ id 不存在 / 主密钥丢失导致解密失败 → 抛错（不返空串伪装成功）

export function saveCredential(input: {
  username: string;
  password: string;   // 字段命名 password / token 复用 logger 自动脱敏
  label?: string;
}): {id: string};
//   └─ encryptString(password) → 追加到数组 → 原子写回 → 返新 id

export function deleteCredential(id: string): {ok: true} | {ok: false};
//   └─ 数组过滤掉 id → 原子写回；ok=false 仅当 id 不存在（幂等删）

// 对外 DTO（types.ts 定义，前端镜像）
export interface CredentialListItemDTO {
  id: string;
  label: string;
  username: string;
  // 无 password / ciphertext / iv / tag 字段
}
```

## 威胁模型（诚实声明）

| 威胁 | 是否缓解 | 说明 |
|------|---------|------|
| 明文落盘被 grep | ✅ | 密文 + IV + tag，`grep password .chery/.secrets/*.json` 无命中 |
| 进程内存 dump | ❌ | 解密后明文在 JS 堆中短暂存在（无法避免，与 OS keychain 同限制） |
| 主密钥 + 密文同时泄露 | ❌ | **obfuscation 级**——任何能读 `.chery/.secret-key` + `.chery/.secrets/*.json` 的本机用户/进程可解 |
| argv 经 `ps auxe` 泄露 token | ✅ | 鉴权走 `GIT_CONFIG_PARAMETERS` env，**不**嵌 URL；env 比 argv 隔离度更高（仍非完美隔离，但已是 git CLI 最佳实践） |
| 日志泄露密令 | ✅ | 字段命名 `password`/`token` → logger 自动 `[REDACTED]`（[./logger.md](./logger.md)） |
| 跨机复制密文 | ✅（部分） | scrypt salt 绑定 `hostname|username`，换机器解不开（缓解备份被偷） |
| 主密钥丢失 | ❌ | 旧密文不可解 → `getCredentialSecret` 抛「凭据不可用，请重新输入」（不崩溃） |

**关键定性**：本方案是 **obfuscation 级**（非 OS keychain），满足「加密存储」承诺（非明文落盘），但**不抵御本机完全控制者**。如需 OS keychain 强度，升级路径为 Electron `safeStorage`（当前未接：后端是独立 Node 子进程，无 Electron 主进程 API 访问权；若未来后端并入 Electron 主进程或通过 IPC 桥接，可无缝替换 `encryptString/decryptString` 内部实现，存储 schema 不变）。

## 关键流程

```
encryptString(plain):
  ├─ loadMasterKey()                  // 读 .secret-key；不存在则 randomBytes(32) 写 0600
  ├─ salt = `${hostname()}|${userInfo().username}`
  ├─ key = scrypt(masterKey, salt, 32)
  ├─ iv = randomBytes(12)
  ├─ cipher = createCipheriv("aes-256-gcm", key, iv)
  ├─ ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  ├─ tag = cipher.getAuthTag()
  └─ return {ciphertext: b64, iv: b64, tag: b64}

saveCredential({username, password, label?}):
  ├─ encryptString(password) → {ciphertext, iv, tag}
  ├─ read .secrets/git-credentials.json（不存在则 []）
  ├─ push({id: uuid(), label, username, ciphertext, iv, tag, createdAt: Date.now()})
  └─ atomicWrite（tmp + rename，mode 0600）

getCredentialSecret(id):
  ├─ find item by id（不存在抛错）
  ├─ decryptString(item.ciphertext, item.iv, item.tag)
  │    └─ authTag 不匹配 / 主密钥丢失 → 抛错（不返空串）
  └─ return plain
```

## 依赖与关联

### utils 内部依赖

| 源 | 目标 | 性质 |
|----|------|------|
| [secretStore.ts](../../src/utils/secretStore.ts) | `node:crypto`（内置） | encrypt/decrypt/scrypt/randomBytes |
| [secretStore.ts](../../src/utils/secretStore.ts) | `node:os`（内置） | hostname / userInfo 取 scrypt salt |

### 被外部依赖

| 调用方 | 调用点 |
|--------|--------|
| [service/credentials/handler.ts](../../src/service/credentials/handler.ts) | `handleCredentialsList/Save/Delete` 包装 RPC，调 `listCredentials/saveCredential/deleteCredential` |
| [service/plugin/import.ts](../../src/service/plugin/import.ts) | `handlePluginsImportUrl` inline 鉴权 + `remember=true` 时调 saveCredential；`credentialId` 复用时调 getCredentialSecret 解密注入 git env |
| [service/skill/import.ts](../../src/service/skill/import.ts) | （预留）未来若 skills 支持私有仓鉴权时复用 |

### 横切参考

- 凭据使用场景与 RPC：[../agent/plugin.md](../agent/plugin.md)「鉴权与凭据池」
- 自动脱敏机制（字段名 `password`/`token` 触发 `[REDACTED]`）：[./logger.md](./logger.md)
- 协议层 `credentials.*`：[../protocol.md](../protocol.md)

## 扩展点

- **新增凭据类型**（如 SSH key / OAuth refresh token）：扩 `StoredCredential` 加 `kind` 字段 + 对应加密字段；list DTO 按需暴露。
- **密钥轮换**：读全部旧密文（旧 masterKey 解）→ 用新 masterKey 重加密 → 原子写回。当前未实现（封闭开发，主密钥稳定）。
- **迁移到 Electron safeStorage**：替换 `encryptString/decryptString` 内部实现为 `safeStorage.encryptString`（Electron 主进程），存储 schema 保持 `{ciphertext, iv?, tag?}` 兼容。需后端进程能访问 Electron API（当前为独立 Node 子进程，未接）。
- **更换存储后端**（sqlite / OS keychain）：改 `loadCredentials`/`atomicWrite` 即可；接口 `listCredentials/getCredentialSecret/saveCredential/deleteCredential` 不变。
