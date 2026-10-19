/**
 * ★★ 盒子与**云端**对账（2026-10-12）。
 *
 * ## 用户报的现象
 *
 * > "云端账号库，盒子的数据没有做好同步。"
 *
 * 实测：**扩展显示 5 个盒子、云端只有 2 个**，而两边都不报错。
 *
 * ## 根因（扩展侧这一半）
 *
 * `ui/parallel/parallel.ts` 的盒子列表是
 * `[defaultBox, ...**本地记住的**, ...账号里出现的]` 取**并集**，
 * 而"本地记住的"（`ql:boxes`）**只会被加、不会被减** ⇒
 * 云端删掉/改名的盒子**永远留在界面上**。
 *
 * （服务端那一半：`/api/vault/snapshot` 里原本没有盒子列表 ⇒ 客户端推不出
 *  "一共有哪些盒子"。已在 `akso-cloud` 修掉并把 `boxes` 纳入 `snapshotId`。）
 *
 * ## 为什么把这段抽成**纯函数**
 *
 * 对账的三条约束里有两条是**反方向**的（"离线不许剪""账号在用的不许剪"）——
 * 只验"剪掉了多余的"是不够的，因为"一律清空"也能过那一条。
 * 而这段真跑起来需要**云端授权**（`par.boxes` 要打 `/api/boxes`），
 * 验证脚本里拿不到 ⇒ 那段逻辑会永远**没被验过**。
 *
 * ⇒ 把它做成**不碰 chrome / 不碰 DOM 的纯函数**：给定三个输入、返回新列表。
 *   于是三种情形都能用**合成数据**直接钉住（见 `tools/verify/verify-boxsync.mjs`），
 *   而 `parallel.ts` 只负责"取数据 + 写回 storage"。
 *
 * ★ 本仓 AGENTS §2：「消息协议单一定义、不要在调用点就地写对象字面量」——
 *   同一个道理：**对账的规则只在这里写一次**，别在 UI 里再抄一遍。
 */

/** 对账的输入。三个数组都是**盒名**（不是盒子对象）。 */
export interface BoxReconcileInput {
  /** 本地记住的盒名（`ql:boxes`）。★ 这一份是**允许被剪**的。 */
  remembered: readonly string[];
  /** 账号数据里正在用的盒名（`boxOf(account)`）。★ 这一份**永远不许剪**。 */
  fromAccounts: readonly string[];
  /** 云端权威名单（`GET /api/boxes` 的 `names`）。 */
  cloudNames: readonly string[];
  /** 云端默认盒名（未归盒账号的归宿）。 */
  defaultBox: string;
}

export interface BoxReconcileResult {
  /**
   * 对账后的盒子列表（顺序：默认盒 → 记住的 → 账号里的 → **云端独有的**，取并集）。
   * ★ 云端独有的是 2026-10-19 补的：网页上新建的空盒子/建站自动建的盒子
   *   此前永远进不了扩展的列表（见函数里那段注释）。
   */
  boxes: string[];
  /** 被剪掉的盒名（供调用点记账/日志；空数组表示没变）。 */
  dropped: string[];
  /** 是否**真的**变了（含"新增"）—— 调用点据此决定要不要写盘。 */
  changed: boolean;
}

/**
 * 用云端名单剪掉本地记住的多余盒名。
 *
 * ## 三条约束（每一条都对应一种"看起来正常但是坏的"）
 *
 * 1. **云端名单为空 ⇒ 原样返回、不剪**：离线时 `par.boxes` 拿不到答复，
 *    此时本地那份是**唯一的真相**。剪掉它，用户会看到"自己的盒子全没了" ——
 *    而离线是本扩展的主要使用场景之一（`par.offline` 那套只读副本就是为此存在）。
 * 2. **账号里正在用的盒名永远不剪**：某个盒名可能因为"账号还没同步过来"
 *    暂时不在云端名单里；剪掉它，用户会看到**自己的账号挂在一个不存在的盒子上**。
 * 3. **默认盒永远在列表里且排第一**：它是"未归盒账号的归宿"，
 *    不是普通盒子（`account.box === ''` 的语义就是它）。
 */
export function reconcileBoxes(input: BoxReconcileInput): BoxReconcileResult {
  const remembered = input.remembered.filter(Boolean);
  const fromAccounts = input.fromAccounts.filter(Boolean);
  const cloudNames = input.cloudNames.filter(Boolean);
  const def = (input.defaultBox || '').trim();

  // ① 没有云端答复 ⇒ 一个字都不动（但仍要保证默认盒在列表里）
  const keepRemembered = cloudNames.length === 0
    ? remembered
    // ② 云端那份是权威；账号在用的名字**另外保底**（它不依赖云端名单）
    : remembered.filter((b) => cloudNames.includes(b) || fromAccounts.includes(b));

  const dropped = remembered.filter((b) => !keepRemembered.includes(b));
  /* ★ 2026-10-19：**云端的空盒子也要进列表**。
   *
   * 旧实现的并集只取「默认盒 + 本地记住的 + 账号里的」——
   * 而"本地记住的"只在**已经进过列表**之后才会被写进 `ql:boxes`。
   * 于是在网页控制台新建一个空盒子 / 建站点时自动建的盒子，
   * 扩展这边**永远看不到它**，直到有人把一个账号移进去。
   * 用户要求"盒子管理自动同步"，一个看不见的新盒子就是没同步。
   *
   * ★ 顺序仍然保持"默认盒 → 记住的 → 账号里的 → 云端独有的"：
   *   云端独有的排在最后，不影响既有顺序的稳定性。
   */
  const boxes = [...new Set([
    ...(def ? [def] : []),
    ...keepRemembered.filter((b) => b !== def),
    ...fromAccounts.filter((b) => b !== def),
    ...cloudNames.filter((b) => b !== def),
  ])];

  /* `changed` 必须把"新增"也算进去 —— 旧版只算 `dropped`。
   * 少了这一半，云端新建的空盒虽然被算进 `boxes`，却不会被写回 `ql:boxes`，
   * 下一次刷新又消失（看起来像"新建的盒子自己没了"）。 */
  const before = new Set([
    ...(def ? [def] : []),
    ...remembered.filter((b) => b !== def),
    ...fromAccounts.filter((b) => b !== def),
  ]);
  const changed = dropped.length > 0 || boxes.length !== before.size || boxes.some((b) => !before.has(b));

  return { boxes, dropped, changed };
}
