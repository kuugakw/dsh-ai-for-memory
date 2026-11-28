# 发布验证

插件本身做记忆安全，发布的 npm 包也应该有一条可核对的来源链。

## 现在能验证什么

| 检查 | 0.5.25 状态 | 怎么验证 |
|---|---|---|
| npm provenance（SLSA v1） | ✅ | `npm view dsh-ai-for-memory@0.5.25 dist.attestations --json`，或打开 attestation URL |
| OIDC trusted publisher | ✅（`_npmUser` 是 GitHub Actions） | 同上；用 token 发布的包没有 `trustedPublisher` |
| tarball integrity / registry signature | ✅ | `npm audit signatures` |
| registry `gitHead` 与 tag 指向同一提交 | ✅ | `node scripts/verify-release.mjs 0.5.25` |
| 签名 tag | ❌（0.5.25 仍是 annotated、未签名） | `git verify-tag v0.5.25` |
| GitHub artifact attestation | 0.5.26 起 | `gh attestation verify dsh-ai-for-memory-<version>.tgz --repo kuugakw/dsh-ai-for-memory` |

一条命令核对发布：

```bash
node scripts/verify-release.mjs 0.5.25
```

它会检查 registry 版本、provenance attestation、tarball integrity、OIDC trusted publisher、`gitHead` 与本地 tag 的提交；tag 未签名时给出 warning。加上 `--require-tag-signature` 会把未签名 tag 当成失败，供维护者或 CI 使用（当前不要默认开，0.5.25 及更早的 tag 都没有签名）。

## 为什么 token 泄露不等于可以安静发恶意版本

- npm 包已启用 **trusted publishing**：0.5.25 的 `_npmUser` 是 `npm-oidc-no-reply@github.com` 且带 `trustedPublisher`。用普通 token 发布的版本不会带这组字段，`verify-release.mjs` 会直接失败。
- provenance 由 GitHub Actions 的 OIDC 身份生成，绑定仓库、工作流和提交；发布后的 `dist.attestations.provenance` 不是 token 能伪造的。
- publish workflow 先 `npm pack`，用 GitHub artifact attestation 绑定**实际发布的那份 tarball**，再 `npm publish` 同一个文件；用户可对下载的 tarball 跑 `gh attestation verify`。
- 发布工作流在 `npm publish` 之后自动跑 `verify-release.mjs` 和 `gh attestation verify`，缺 provenance 或 tarball 不匹配都会让 release 失败。

这不能阻止账户被完全接管后发布一个“看起来正常”的版本，但能让用户区分“由本仓库工作流发布”和“用某个 token 直接推上来的包”。

## 签名 tag（还需要密钥）

Tag 签名需要维护者自己的 GPG/SSH 私钥，仓库和 CI 都不能代替。配置一次即可：

```bash
git config gpg.format ssh
git config user.signingkey ~/.ssh/dsh-release-signing.pub
git tag -s v0.5.26 -m "0.5.26"
git push origin v0.5.26
```

同时把对应的 SSH 公钥加到 GitHub 账号的 **Signing keys**，GitHub 才会把该 tag 标成 Verified。配好之后可以：

- 在本地用 `git verify-tag v0.5.26`；
- 把 `verify-release.mjs` 加上 `--require-tag-signature`，或在 CI 里加同样的门，未签名就不发布。

在配置密钥之前，0.5.25 及更早的 tag 无法补签成“最初发布时的签名”——补签会改变 tag 对象；正确的做法是从下一个版本开始签，不要重写已发布 tag。

## 发布前检查清单

1. `npm test`、`npm run check`、`npm run typecheck`、`npm run coverage`；
2. tag 用 `-s` 签名，且 tag 名与 `package.json` 版本一致；
3. `publish` workflow 用 OIDC `npm publish --provenance`，不要用 `NPM_TOKEN`；
4. 发布后跑 `node scripts/verify-release.mjs <version>`；
5. 下载 registry tarball 跑 `gh attestation verify`，确认它是 workflow 生成的那一份。
