// 同一份可恢复协作数据：问题单 + 处理记录 + 合并关系。
// - 乐观并发：保存前比较双方修订（rev），不一致则保留两份并请审核员选定，而不是覆盖。
// - 原子写入：问题单、处理记录、合并关系在同一次状态变更中提交；失败则原值保留、整包入箱可重试。
// - 重开只继续一次：发件箱在重新加载后对每条记录只尝试一次，且幂等不重复写入。
// - 合并链路收敛：无论经过几层，旧链接都沿 canonicalId 回到最终问题单（路径压缩）。

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  canonicalId?: string;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  /** 乐观并发版本号：每次成功提交 +1，用于保存前比较双方修订。 */
  rev: number;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

/** 修订冲突：同时保留审核员持有的旧版本(local)与对方已保存的新版本(remote)，等待选定。 */
export interface IssueConflict {
  id: string;
  issueId: string;
  baseRev: number;
  local: AuditIssue;
  remote: AuditIssue;
  localSummary: string;
  remoteSummary: string;
  createdAt: string;
}

/** 发件箱：一次未能落库的原子写入包，原值未动，可重试。 */
export interface OutboxItem {
  id: string;
  issueId: string;
  issue: AuditIssue;
  events: AuditEvent[];
  mergeLinks: Record<string, string>;
  attempts: number;
  status: 'pending' | 'failed';
  createdAt: string;
}

export interface WorkbenchState {
  issues: AuditIssue[];
  events: AuditEvent[];
  conflicts: IssueConflict[];
  outbox: OutboxItem[];
}

export const now = () => new Date().toISOString();
export const newId = (): string => {
  try {
    return crypto.randomUUID();
  } catch {
    return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
};
export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function issueStatusLabel(status: IssueStatus): string {
  return (
    {
      open: '待分诊',
      triaged: '已分诊',
      fixing: '修复中',
      verifying: '待复测',
      closed: '已关闭',
      reopened: '重新打开'
    } as const
  )[status];
}

// ---------- 合并关系：沿 canonicalId 找到最终问题单 ----------
export function resolveCanonicalId(issues: AuditIssue[], startId: string): string {
  let current = startId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) return current; // 环保护：异常链路下回到已访问节点
    seen.add(current);
    const next = issues.find((i) => i.id === current)?.canonicalId;
    if (!next) return current;
    current = next;
  }
  return current;
}

// 路径压缩：无论甲→乙→丙有几层，旧链接都直接指向最终问题单。
export function compressCanonicals(issues: AuditIssue[]): AuditIssue[] {
  return issues.map((issue) => {
    if (!issue.canonicalId) return issue;
    const root = resolveCanonicalId(issues, issue.id);
    return root === issue.id ? { ...issue, canonicalId: undefined } : { ...issue, canonicalId: root };
  });
}

export function summarizeIssue(issue: AuditIssue): string {
  const parts = [`状态：${issueStatusLabel(issue.status)}`, `严重程度：${issue.severity}`];
  if (issue.fixNote) parts.push(`修复说明：${issue.fixNote}`);
  if (issue.retestNote) parts.push(`复测记录：${issue.retestNote}`);
  return parts.join('；');
}

function upsertConflict(conflicts: IssueConflict[], conflict: IssueConflict): IssueConflict[] {
  return [conflict, ...conflicts.filter((c) => c.issueId !== conflict.issueId)];
}

// ---------- 原子写入：问题单 + 处理记录 + 合并关系 ----------
export interface BundleInput {
  issueId: string;
  baseRev: number;
  /** 审核员基于旧版本改好的完整问题单（提交时会重新分配 rev）。 */
  local: AuditIssue;
  /** 本次追加的处理记录（审计消息）。 */
  messages: string[];
  /** 本次一并写入的合并关系变更。 */
  mergeLink?: { fromId: string; toId: string };
}

export type BundleResult =
  | { status: 'applied'; state: WorkbenchState; issue: AuditIssue }
  | { status: 'conflict'; state: WorkbenchState; conflict: IssueConflict }
  | { status: 'failed'; state: WorkbenchState; item: OutboxItem };

export function commitBundle(
  prev: WorkbenchState,
  input: BundleInput,
  opts: { failWrite?: boolean } = {}
): BundleResult {
  const current = prev.issues.find((i) => i.id === input.issueId);
  if (!current) {
    const fallback = deepClone(input.local);
    return {
      status: 'conflict',
      state: prev,
      conflict: {
        id: newId(),
        issueId: input.issueId,
        baseRev: input.baseRev,
        local: fallback,
        remote: fallback,
        localSummary: summarizeIssue(fallback),
        remoteSummary: summarizeIssue(fallback),
        createdAt: now()
      }
    };
  }

  // 保存前比较双方修订：版本号不一致，说明对方已提交更新 → 进入冲突，保留两份而不是覆盖。
  if (current.rev !== input.baseRev) {
    const local = { ...deepClone(input.local), rev: input.baseRev };
    const remote = deepClone(current);
    const conflict: IssueConflict = {
      id: newId(),
      issueId: input.issueId,
      baseRev: input.baseRev,
      local,
      remote,
      localSummary: summarizeIssue(local),
      remoteSummary: summarizeIssue(remote),
      createdAt: now()
    };
    return {
      status: 'conflict',
      state: { ...prev, conflicts: upsertConflict(prev.conflicts, conflict) },
      conflict
    };
  }

  // 版本一致：把问题单、处理记录、合并关系组装成同一份写入。
  const newIssue: AuditIssue = { ...deepClone(input.local), rev: current.rev + 1, updatedAt: now() };
  const newEvents: AuditEvent[] = input.messages.map((message) => ({
    id: newId(),
    at: now(),
    issueId: input.issueId,
    message
  }));

  let nextIssues = prev.issues.map((i) => (i.id === input.issueId ? newIssue : i));
  if (input.mergeLink) {
    nextIssues = nextIssues.map((i) =>
      i.id === input.mergeLink!.fromId ? { ...i, canonicalId: input.mergeLink!.toId } : i
    );
    nextIssues = compressCanonicals(nextIssues);
  }
  const nextEvents = [...newEvents, ...prev.events];

  if (opts.failWrite) {
    // 写入失败：问题单与处理记录原值保留不变，整包进入发件箱，等待重试。
    const item: OutboxItem = {
      id: newId(),
      issueId: input.issueId,
      issue: newIssue,
      events: newEvents,
      mergeLinks: input.mergeLink ? { [input.mergeLink.fromId]: input.mergeLink.toId } : {},
      attempts: 1,
      status: 'failed',
      createdAt: now()
    };
    return { status: 'failed', state: { ...prev, outbox: [item, ...prev.outbox] }, item };
  }

  // 原子提交：一次状态变更同时落库问题单、处理记录、合并关系，并清掉该问题的冲突与发件箱。
  const nextState: WorkbenchState = {
    issues: nextIssues,
    events: nextEvents,
    conflicts: prev.conflicts.filter((c) => c.issueId !== input.issueId),
    outbox: prev.outbox.filter((o) => o.issueId !== input.issueId)
  };
  return { status: 'applied', state: nextState, issue: newIssue };
}

// ---------- 冲突选定：二选一，选定后才能继续（未选定不能关闭问题） ----------
export type ResolveResult =
  | { status: 'applied'; state: WorkbenchState; issue: AuditIssue }
  | { status: 'failed'; state: WorkbenchState; item: OutboxItem }
  | { status: 'missing'; state: WorkbenchState };

export function resolveConflictBundle(
  prev: WorkbenchState,
  issueId: string,
  choice: 'local' | 'remote',
  opts: { failWrite?: boolean } = {}
): ResolveResult {
  const conflict = prev.conflicts.find((c) => c.issueId === issueId);
  if (!conflict) return { status: 'missing', state: prev };
  const chosen = choice === 'local' ? conflict.local : conflict.remote;
  const baseRev = Math.max(conflict.local.rev, conflict.remote.rev);
  const local: AuditIssue = { ...deepClone(chosen), rev: baseRev };
  const messages = [`审核员在修订冲突中选择采用${choice === 'local' ? '我方（旧版本）' : '对方（新版本）'}修订`];
  const result = commitBundle(prev, { issueId, baseRev, local, messages }, opts);
  if (result.status === 'conflict') return { status: 'missing', state: prev };
  return result;
}

// ---------- 发件箱：写入失败保留原值，可重试；重开后只继续一次且幂等 ----------
export function applyOutboxItem(
  prev: WorkbenchState,
  item: OutboxItem,
  opts: { failWrite?: boolean } = {}
): WorkbenchState {
  const current = prev.issues.find((i) => i.id === item.issueId);

  // 幂等：若该包已经落库（当前版本不低于包内版本），绝不重复写入——重开后只继续一次。
  if (current && current.rev >= item.issue.rev) {
    return {
      ...prev,
      outbox: prev.outbox.filter((o) => o.id !== item.id),
      conflicts: prev.conflicts.filter((c) => c.issueId !== item.issueId)
    };
  }

  if (opts.failWrite) {
    return {
      ...prev,
      outbox: prev.outbox.map((o) =>
        o.id === item.id ? { ...o, attempts: o.attempts + 1, status: 'failed' } : o
      )
    };
  }

  const newIssue: AuditIssue = {
    ...deepClone(item.issue),
    rev: current ? current.rev + 1 : item.issue.rev,
    updatedAt: now()
  };
  let nextIssues = prev.issues.map((i) => (i.id === item.issueId ? newIssue : i));
  if (Object.keys(item.mergeLinks).length) {
    nextIssues = nextIssues.map((i) =>
      item.mergeLinks[i.id] ? { ...i, canonicalId: item.mergeLinks[i.id] } : i
    );
    nextIssues = compressCanonicals(nextIssues);
  }
  const nextEvents = [...item.events, ...prev.events];

  return {
    issues: nextIssues,
    events: nextEvents,
    conflicts: prev.conflicts.filter((c) => c.issueId !== item.issueId),
    outbox: prev.outbox.filter((o) => o.id !== item.id)
  };
}

export function retryOutboxItem(
  prev: WorkbenchState,
  itemId: string,
  opts: { failWrite?: boolean } = {}
): { state: WorkbenchState; applied: boolean } {
  const item = prev.outbox.find((o) => o.id === itemId);
  if (!item) return { state: prev, applied: false };
  const next = applyOutboxItem(prev, item, opts);
  return { state: next, applied: !next.outbox.some((o) => o.id === itemId) };
}

// 重新打开（重新加载）后只继续一次：对发件箱中每条记录恰好尝试一次，不循环重试。
export function flushOutbox(
  prev: WorkbenchState,
  opts: { failWrite?: boolean } = {}
): { state: WorkbenchState; attempted: number; applied: number } {
  let state = prev;
  let applied = 0;
  for (const item of [...prev.outbox]) {
    const before = state.outbox.length;
    state = applyOutboxItem(state, item, opts);
    if (state.outbox.length < before) applied += 1;
  }
  return { state, attempted: prev.outbox.length, applied };
}
