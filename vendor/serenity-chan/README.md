# serenity-chan-stock-skill

**给认真的个人投资者的 AI 研究流水线：先拿真实数据，再让 AI 像分析师一样交作业，结论必须过闸门，判断留成绩单。**

它不荐股、不承诺收益、不替你做决定。它做的是：把"这只股票 / 这组候选 / 这个机会值不值得研究"变成一份**有数据出处、有证据边界、事后可以对答案**的研究。

Language: 中文（本页）| [English](#english)

---

## 和直接问 AI 有什么区别

| | 直接问 AI | serenity-chan |
|---|---|---|
| 数据从哪来 | 模型记忆，可能过时或编造 | 当天从交易所/巨潮/SEC/HKEX 实取，留原始文件和 hash |
| 结论怎么约束 | 想说什么说什么 | 缺关键数据就封顶评级、禁止给买点；弱证据顶多算线索 |
| 事后怎么追责 | 无 | 正式报告带校验凭证；预测写入账本，到期自动结算误差 |

## 一个真实的例子

问它一只股票的数据面（下面是 2026-07-03 在本机的真实运行）：

```bash
python scripts/serenity.py ask "688019 数据面怎么样" --symbols 688019
```

它会自己完成四步：**识别市场 → 从官方源取数（行情/财报 PDF/公告/股本市值）→ 校验勾稽 → 渲染报告**，约 50 秒后给出：

```markdown
# 688019.SH 数据审计报告

## 2. Data Manifest
| Dataset | Status | Source | Level | As-of |
|---|---|---|---|---|
| current_quote | OK | Eastmoney_Quote_Kline_L2 | L2 | 2026-07-03 |
| financials | OK | CNINFO_FinancialReports_L0 | L0_OFFICIAL_DISCLOSURE | 2026-03-31 |
| filings_announcements | OK | CNINFO_Announcements_L0 | L0_OFFICIAL_DISCLOSURE | 2026-07-02 |
| customer_order_capacity_evidence | OK | Disclosure_..._L0 | L0 | 2026-04-28 |

## 7. Rating Cap
- 完整研究评级上限：S
- 取数尝试：27 次；缺口 0；研究债务 0
> 本报告只呈现取数与校验事实，不构成研究结论。
```

注意它**说了什么**：每个数据集的来源、级别、日期，评级上限的依据。也注意它**拒绝说什么**：没有"值得买"，没有目标价——那些要走正式研究路线（`--formal`），让 AI 写出带假设、证据测试、反方观点和情景的深研档案，全部过校验器才能交付。

市场环境也一样是真数据（同日真实输出，6 个基准指数 1.8 秒）：

```text
沪深300 | STRONG_EXTENDED_WATCH | close 4881.67
恒生指数 | WEAK_OR_DOWNTREND    | close 23315.27
regime: RISK_ON —— 市场环境支持推进到触发器和买点观察，但仍需个股证据与结构确认。
```

## 安装与快速开始

依赖：Python ≥ 3.10（核心零第三方依赖；装 `pdfplumber` 可解锁 A股/港股官方 PDF 财报抽取）。

```bash
git clone https://github.com/lucisxu6-cpu/serenity-chan.git
cd serenity-chan
python scripts/serenity.py doctor          # 环境体检：网络源、依赖、数据目录
python scripts/serenity.py ask "688019 值得研究吗" --symbols 688019
```

- **Codex**：把仓库放进 skills 目录（如 `~/.codex/skills/serenity-chan-stock-skill`），用 `$serenity-chan-stock-skill` 调用。
- **Claude Code**：软链到 `~/.claude/skills/serenity-chan-stock-skill`，自然语言提问即可触发。
- 美股数据需要 SEC 身份标识：`export SEC_USER_AGENT="你的名字 你的邮箱"`（SEC 免费接口的礼貌性要求，不用注册）。

## 它能回答什么

| 你问 | 一条命令 | 你得到 |
|---|---|---|
| 这只股票数据面/值得研究吗 | `serenity.py ask "..." --symbols 688019` | 数据审计 + 评级边界 |
| 这两三个候选谁优先 | `serenity.py ask "..." --symbols A B` | 研究简报（加 `--formal` 升级为带 AI 深研和交付凭证的正式对比） |
| 当前有什么便宜机会（可排板块/限价格） | `serenity.py ask "A股机器人便宜机会" --exclude-board STAR --max-price 20` | 可审计的候选漏斗 + shortlist + 下一步命令 |
| 现在该怎么办/怎么配置 | 正式对比之后走策略路线（见 SKILL.md） | 情景概率 + 触发器 + 失效条件；**仓位建议只在你提供持仓上下文后输出** |
| **我现在该干什么** | `serenity.py next` | 决策简报：实时市场环境 + 观察名单现价/量能热度/条件机器判定命中 + 组合对基准与集中度告警 + 到期必办 + 决策成绩单（你上次跳过的动作此后涨跌多少）→ 优先级动作队列；AI 再按契约写逐动作 EXECUTE/DEFER/SKIP 咨询（无持仓禁仓位数字、无校准历史禁 HIGH 置信），用 `decide` 记录你的选择 |
| 上次的判断到期了吗、准不准 | `serenity.py review --fetch` | 到期复盘任务 + 预测自动结算 + 校准报告（历史误差会自动收紧未来的证据门槛） |

## 当前真正的能力（诚实边界）

不夸大：能力分三档，档位是实测出来的，不是设计出来的。

| 档位 | 具体能力 | 状态 |
|---|---|---|
| **全自动，今天就可信** | A股/美股/港股数据审计（官方源实取+勾稽校验+评级封顶）；市场环境测量（6 基准指数秒级）；候选研究简报；决策简报（`next`）；到期预测自动结算与校准；持仓 CSV → 实时权重 | 本机实测通过，秒级到分钟级 |
| **自动化框架 + AI 判断** | 正式候选对比（AI 深研档案过质量闸门才能交付）；单股 memo；策略情景/触发器/失效条件 | 流程和门禁是硬的，**数值判断是 AI 写的**——系统保证它"认真做过作业且可追溯"，不保证它对 |
| **明确不做** | 荐股与收益承诺；无持仓上下文时的任何仓位数字；缺关键数据时的结论（只会告诉你缺什么）；事件日历（财报日/解禁）暂未接入 | 设计边界，不是缺陷 |

一句话：**它保证研究过程可信、判断可追责，把"下一步该做什么"送到你手边；最终判断和决策仍然是你的。**

## 顶层实现逻辑

整个系统是一个闭环，六层各管一件事，上一层的输出是下一层的输入：

```text
你的问题
  ↓
[取数层]  官方源实取，留原始文件+hash+尝试账本；缺什么数据，评级上限就降到哪
  ↓
[研究层]  AI 写深研档案（读源/假设/证据测试/反方/情景），质量闸门不过 = 不许交付
  ↓
[交付层]  校验器真实跑一遍，退出码+产物 hash 写进凭证；终验重算 hash，手写 PASS 无效
  ↓
[状态层]  结论进 state/（观察名单+持仓上下文）——不进状态的研究，等于没做
  ↓
[决策层]  `next` 聚合全部现实（市场环境/现价对照条件/到期任务/未完成研究）→ 优先级动作队列
  ↓
[校准层]  可检验的预测写入账本 → 到期自动用行情结算 Brier 误差 → 误差高自动收紧研究层的证据门槛
  ↺ 回到下一个问题（这次系统更知道自己几斤几两）
```

三条设计法则贯穿所有层：

1. **缺数据就降级，永不猜**——每类数据失败对应明确的评级上限，A股问题禁用美股数据源（反之亦然）。
2. **AI 的自由在研究，约束在结论**——档案里可以大胆假设，但结论要过校验器、带凭证、可重验。
3. **每个判断都要能事后对答案**——预测入账、自动结算、历史误差反哺未来门槛：系统为自己的判断出示成绩单。

细节：[SKILL.md](SKILL.md)（路由与门禁）、[references/](references/)（方法论 9 篇）、[CHANGELOG.md](CHANGELOG.md)。

## 边界，请先读

- 研究辅助工具，输出研究优先级与行动条件，**不构成投资建议**，投资决策与后果由使用者承担。
- 数据来自免费公开源（交易所披露、SEC、行情接口），可用性随环境变化；`doctor` 会告诉你当前哪些源可达。
- 快速模式给的是研究简报，不是结论；正式结论必须走 `--formal` 全链。
- 无持仓上下文时不输出加减仓与仓位数字——这是设计，不是缺陷。

---

## English

**An AI research pipeline for serious individual investors: real data first, AI does analyst-grade homework, conclusions must pass gates, and judgments keep a scorecard.**

It does not pick stocks, promise returns, or decide for you. It turns "is this stock / candidate set / opportunity worth researching" into research with data provenance, evidence boundaries, and after-the-fact accountability: fetched-and-hashed official disclosures (CNINFO/SEC/HKEX + market quotes), rating caps when critical data is missing, AI research dossiers validated before delivery, delivery proofs with re-verifiable hashes, and a forecast ledger whose due claims are auto-resolved against live prices — historical error tightens future evidence bars automatically.

```bash
python scripts/serenity.py doctor
python scripts/serenity.py ask "quick look" --symbols NVDA
python scripts/serenity.py ask "compare" --formal --symbols 688019 688322   # formal, AI-research-gated
python scripts/serenity.py review --fetch                                   # due reviews + claim resolution + calibration (state watchlist by default)
python scripts/serenity.py next                                              # decision brief: reality -> prioritized actions; then AI writes contract-validated counsel
python scripts/serenity.py decide 2 --skip --note "wait for earnings"        # decision journal feeds the next brief's scoreboard
```

Requires Python ≥ 3.10, stdlib-only core (`pdfplumber` optional, unlocks official PDF financial extraction; set `SEC_USER_AGENT` for US filings). Mount under your agent's skills directory (Codex or Claude Code). Details: [SKILL.md](SKILL.md) and [references/](references/). Research assistance only — investment decisions remain yours.
