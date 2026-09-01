# Waffo 支付合约与上线验收

**合约捕获日期：2026-08-08，对应 SDK `@waffo/pancake-ts` 0.16.0（精确锁定）。**

状态：**SDK 合约已捕获；真实商户资源验证仍未完成，部署环境的交易功能不得开启。**

## 基本信息

- 包名：`@waffo/pancake-ts`
- 版本：`0.16.0`（精确锁定，不允许版本范围）
- 产品：Waffo Pancake Merchant of Record SDK
- 默认 API 地址：`https://api.waffo.ai`
- 商户请求通过 SDK 用 RSA-SHA256 签名并携带商户身份头

## 结账合约

模板使用带身份的结账：

```ts
client.checkout.authenticated.create({
  productId,
  currency,
  buyerIdentity,
  buyerEmail,
  successUrl,
  orderMerchantExternalId,
})
```

本地留存的 `account_subjects.id` 作为稳定的 `buyerIdentity`。本地订单 UUID 作为 `orderMerchantExternalId` 传出去，这是一个**由商户控制的对账键**，之后会出现在订单/支付/退款事实和 webhook 上。

SDK 返回结账 `sessionId`、`checkoutUrl`、过期/会话令牌信息。**它在创建结账时不给出最终的 Waffo 订单 ID**；最终订单 ID 在收到已验证的服务商事件时才绑定。

浏览器绝不提供权威的金额、币种、Waffo 商品 ID 或权益——这些由服务端商品目录决定。**创建结账本身不证明支付成功。**

## 金额合约

Waffo 的金额是**十进制展示字符串**，不是整数最小单位。SDK 文档里的例子包括美元 `"29.00"` 和日元 `"4500"`。

模板用一张显式评审过的币种指数表，把展示字符串转成 BIGINT 最小单位。不支持的币种和精度不匹配一律**失败关闭**。原始展示值只在诊断需要时保留；金额相等性一律在"最小单位 + 币种"上判断。

## 支付查询合约

锁定版 SDK 文档暴露了商户 GraphQL 支付查询、与列表同过滤条件的 `paymentsCount`、支付的 `snapshotAmountDetails`、`createdAt`，以及互斥的 `onetimeOrder` / `subscriptionOrder` 关联。它明确记载了 `OnetimeOrder.testMode`；而订阅支付查询的文档**没有**确立支付级别的订阅周期。

应用查询限定 100 行：

```graphql
query ($reference: String!, $paymentId: String!) {
  payments(
    limit: 100
    filter: {
      orderMerchantExternalId: { eq: $reference }
      id: { eq: $paymentId }
    }
  ) {
    id
    orderId
    status
    orderMerchantExternalId
    snapshotAmountDetails { currency total }
    onetimeOrder { id testMode store { id } }
    subscriptionOrder { id store { id } }
    createdAt
  }
  paymentsCount(
    filter: {
      orderMerchantExternalId: { eq: $reference }
      id: { eq: $paymentId }
    }
  )
}
```

两个身份标识可以只给其一，但**两者都给时，两者都必须同时出现在 list 和 count 的过滤条件里，并对每条返回的支付逐一校验**。适配器还要求：

- list 长度等于 `paymentsCount`，count 不超过 100，支付 ID 唯一；
- 提供了本地订单引用时，`orderMerchantExternalId` 必须匹配；
- 恰好一个服务商订单关联，其 `id` 等于 `payment.orderId`，其 `store.id` 等于配置的店铺；
- 一次性订单的 `testMode` 精确映射到本地的 `test` / `production`；
- 支付状态受支持、币种为受支持的大写形式、小数精度精确、服务商 `createdAt` 为严格 UTC；
- 任何 GraphQL `errors`（**包括"部分数据 + errors"**）一律失败关闭。

每次查询都创建一个请求级 SDK 客户端，其自定义 fetch 接收合并后的调用方 abort 信号和一个有界超时。服务商警告不会被丢弃：只有 `message`、`layer` 和可选的 `aiHint` 会离开适配器，供对账任务持久化成白名单审计记录。

这些测试是拿代码对照仓库里存档的 SDK 0.16.0 文档和一份受控的线上装置做的验证。**它们不能证明已认证的真实商户 schema 或资源。**

## 漏收 webhook 的恢复边界

自动恢复**只**限于无歧义的一次性支付事实。

通过 GraphQL 发现的订阅支付事实必须隔离出来交人工复核，原因写 `payment-level period unavailable`，并且**不得产生任何**支付行、订阅周期、履约任务或积分发放。

`subscriptionOrder.currentPeriodStart` 和 `currentPeriodEnd` 是**当前订单投影字段**，不是被证实的历史支付周期字段，绝不能拷到恢复出来的订阅支付上。订阅恢复只有在真实 schema 或留存的历史事件证明存在权威的支付级周期边界之后，才能重新考虑。

**因此这套实现可能代码上是安全的，但所有者激活状态仍然是 NO-GO。**

## Webhook 合约

签名头：`x-waffo-signature`。

验签针对**精确的原始请求体**，用 `client.webhooks.verify(...)`。SDK 边界上的环境值是 `test` 和 `prod`，应用把它们映射到内部的 `test` 和 `production`。

已验证事件信封字段：

- `id`：用于去重的 webhook 投递标识
- `timestamp`
- `eventType`
- `eventId`
- `storeId`
- `storeName`
- `mode`
- `data`

SDK 0.16.0 暴露的相关事件类型：

```
order.completed
subscription.activated
subscription.payment_succeeded
subscription.canceling
subscription.uncanceled
subscription.updated
subscription.canceled
subscription.past_due
refund.succeeded
refund.failed
```

相关 data 字段包括 `orderId`、`orderMerchantExternalId`、`paymentId`、`paymentStatus`、`currency`、`amount`、订阅周期字段和退款字段。

已验证 webhook 路径处理一次性、退款和带类型的订阅事件。**订阅激活/支付变更所需的周期边界必须来自那个签名事件本身。** 这和 GraphQL 漏收恢复是两回事：查询结果不能拿当前订单周期字段去顶替缺失的支付级历史。

## 留存合约

- **验签失败的载荷**：绝不留存原始请求体，只留哈希/大小这类有界诊断信息。
- **已知的合法事件**：默认只留归一化的白名单事实。
- **合法但不支持的签名事件**：可以在一个有界的例外窗口内留存加密的原始请求体，附带密钥 ID、过期时间和清除时间戳。
- **原始载荷绝不写日志。**

## 真实资源验收门禁

仓库目前没有可以证明商户资源归属的 Waffo 账号/工具。在 `staging` 或 `production` 开启交易之前，所有者必须用自己的 Waffo 资源验证：

1. 商户 ID 和 RSA 请求签名可用。
2. 店铺 ID 属于该商户，且与 webhook 投递一致。
3. 测试和生产商品 ID 映射到预期的不可变商品版本/币种。
4. 测试 webhook 公钥能验证一次真实的 Waffo 投递；生产密钥单独配置。
5. `orderMerchantExternalId` 能原样往返回本地订单 UUID。
6. `order.completed` 暴露出预期的订单/支付/金额/币种事实。
7. 退款事件、以及启用订阅时的订阅事件，形状与已捕获的 SDK 合约一致。
8. 同一次投递重放会被去重。

## 支付查询的强制激活门禁

这一关是在上面八条之外**额外**要求的。所有者必须针对已认证的 Waffo **测试**商户资源完成以下全部并留存证据：

1. 跑一次已认证的商户 GraphQL 内省，确认支付过滤条件和所选关联字段存在，且标量/对象形状符合预期。
2. 执行测试查询，证明商户引用和支付 ID 使用 `String!` 变量，其中包含一次**同时提供两个身份**的请求。
3. 确认支付列表和 `paymentsCount` 用的是完全相同的过滤条件、列表有显式 limit，并且在没有截断、数量不符或重复 ID 的前提下满足完整性。
4. 检查一笔真实支付，确认其一次性订单关联、`testMode`、店铺、金额、币种和 `createdAt` 精确映射到本地的测试订单。
5. 抓一份有代表性的一次性支付快照，与本地订单引用、服务商订单/支付 ID、商品模型、金额、币种、店铺、环境和服务商创建时间逐项核对。
6. **在真实 schema 或留存的历史事件证明该笔支付存在支付级不可变订阅周期之前，不要开启订阅恢复。** 在那之前，订阅自动恢复保持 NO-GO。

**在原始资源清单和这份支付查询门禁都通过之前，不得设置 `WAFFO_CONTRACT_VERIFIED=1`。** 运行时会在该标志未设置时拒绝部署环境的交易功能，但**这个标志本身不构成任何一份清单已完成的证据**。
