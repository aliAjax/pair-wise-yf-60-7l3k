import assert from 'node:assert/strict';
import {
  CollabDoc,
  PendingOperation,
  StorageAdapter,
  buildSaveOp,
  commitWAL,
  compressLinks,
  discardWALOperation,
  readDoc,
  resolveRoot,
  resumeWAL,
  seedDoc,
  snapshotOf,
  stageOperation
} from './collab.ts';

class MemoryAdapter implements StorageAdapter {
  doc: string | null = null;
  wal: string | null = null;
  failures = 0;
  walFailures = 0;
  loadDoc() { return this.doc; }
  saveDoc(s: string) {
    if (this.failures > 0) { this.failures -= 1; throw new Error('disk full'); }
    this.doc = s;
  }
  loadWAL() { return this.wal; }
  writeWAL(s: string) {
    if (this.walFailures > 0) { this.walFailures -= 1; throw new Error('wal full'); }
    this.wal = s;
  }
  clearWAL() { this.wal = null; }
}

let passed = 0;
const test = async (name: string, fn: () => void | Promise<void>) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// 两个审核员各持一份“同一时刻”的视图：模拟甲先保存后乙再保存
const freshEnv = () => {
  const adapter = new MemoryAdapter();
  const seed = seedDoc();
  adapter.doc = JSON.stringify(seed);
  return { adapter, seed };
};

await test('合并链路多层嵌套：路径压缩后旧链接都直达最终问题单', () => {
  const links = { a: 'b', b: 'c', c: 'd' };
  assert.equal(resolveRoot(links, 'a').root, 'd');
  assert.deepEqual(resolveRoot(links, 'a').chain, ['a', 'b', 'c', 'd']);
  const compressed = compressLinks(links);
  assert.deepEqual(compressed, { a: 'd', b: 'd', c: 'd' });
  // 种子数据：issue-4 -> issue-3 -> issue-2
  assert.equal(resolveRoot(seedDoc().mergeLinks, 'issue-4').root, 'issue-2');
  assert.deepEqual(compressLinks(seedDoc().mergeLinks), { 'issue-4': 'issue-2', 'issue-3': 'issue-2' });
});

await test('合并关系检测环', () => {
  const links = { a: 'b', b: 'a' };
  assert.throws(() => resolveRoot(links, 'a'), /存在环/);
});

await test('并发改同一字段：两份修订都留下，文档保留对方值，状态冲突阻止关闭', () => {
  const { adapter, seed } = freshEnv();
  const issue = seed.issues.find((i) => i.id === 'issue-1')!;
  const baseAtLoad = snapshotOf(issue);

  // 甲先保存：分诊 -> 修复中
  const jia = { ...baseAtLoad, status: 'fixing' as const, fixNote: '甲：焦点陷阱修复中' };
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员甲', base: baseAtLoad, patch: { status: 'fixing', fixNote: '甲：焦点陷阱修复中' } }));
  commitWAL(adapter);

  // 乙拿着旧版本也保存：分诊 -> closed（双方都改了 status；乙还改了 retestNote）
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员乙', base: baseAtLoad, patch: { status: 'closed', retestNote: '乙：复测通过' } }));
  const report = commitWAL(adapter);

  assert.equal(report.conflicted.length, 1);
  const doc: CollabDoc = JSON.parse(adapter.doc!);
  const after = doc.issues.find((i) => i.id === issue.id)!;
  assert.equal(after.status, 'fixing', '冲突字段保留先落盘（对方）值');
  assert.equal(after.fixNote, '甲：焦点陷阱修复中');
  assert.equal(after.retestNote, '乙：复测通过', '不冲突字段自动合并');

  const conflict = doc.conflicts.find((c) => c.id === report.conflicted[0].conflictId)!;
  assert.equal(conflict.fields.length, 1);
  assert.equal(conflict.fields[0].field, 'status');
  assert.equal(conflict.fields[0].mine, 'closed');
  assert.equal(conflict.fields[0].theirs, 'fixing');
  assert.equal(conflict.fields[0].chosen, undefined);
});

await test('冲突未选定不能关闭：关闭动作被拦截，必须逐字段选定后才生效', () => {
  const { adapter, seed } = freshEnv();
  const issue = seed.issues.find((i) => i.id === 'issue-1')!;
  const base = snapshotOf(issue);
  // 甲：进入修复中并写修复说明
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员甲', base, patch: { status: 'fixing', fixNote: '甲的修复说明' } }));
  commitWAL(adapter);
  // 乙拿着旧版本直接保存关闭：状态冲突，关闭被护栏拦截
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员乙', base, patch: { status: 'closed', retestNote: '乙：复测通过' } }));
  const r2 = commitWAL(adapter);
  assert.equal(r2.conflicted.length, 1);
  const cid = r2.conflicted[0].conflictId;
  const docPending: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(docPending.issues.find((i) => i.id === issue.id)!.status, 'fixing', '未选定前不能关闭');

  // 未选全：校验失败，操作留在 WAL 且记录原因；文档不变
  stageOperation(adapter, { id: 'resolve-bad', type: 'resolve', conflictId: cid, by: '审核员甲', createdAt: new Date().toISOString(), attempts: 0, resumed: false, choices: [] });
  const badReport = commitWAL(adapter);
  assert.ok(badReport.rejected[0]?.error.includes('必须选定'));
  assert.equal(badReport.failure, undefined);
  const walCheck = JSON.parse(adapter.wal!) as PendingOperation[];
  assert.ok(walCheck.find((o) => o.id === 'resolve-bad')?.lastError?.includes('必须选定'));
  const docNow: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(docNow.issues.find((i) => i.id === issue.id)!.status, 'fixing');

  // 审核员放弃这次不完整的选定，重新逐字段选择；选甲的 fixing（仍不关闭）
  discardWALOperation(adapter, 'resolve-bad');
  stageOperation(adapter, { id: 'resolve-ok', type: 'resolve', conflictId: cid, by: '审核员甲', createdAt: new Date().toISOString(), attempts: 0, resumed: false, choices: [{ field: 'status', choice: 'theirs' }] });
  commitWAL(adapter);
  const doc2: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(doc2.issues.find((i) => i.id === issue.id)!.status, 'fixing');
  const conflict = doc2.conflicts.find((c) => c.id === cid)!;
  assert.equal(conflict.resolvedAt !== undefined, true);
  assert.equal(conflict.fields[0].chosen, 'theirs', '两份候选与选择结果都保留');
  assert.ok(doc2.records.some((r) => r.kind === 'conflict-resolution'));
});

await test('问题单与处理记录一起写入：文档保存失败时两者都保留原值，可重试', () => {
  const { adapter, seed } = freshEnv();
  const issue = seed.issues.find((i) => i.id === 'issue-1')!;
  const base = snapshotOf(issue);
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员甲', base, patch: { status: 'fixing', fixNote: '尝试写入的修复说明' } }));

  adapter.failures = 1;
  const failed = commitWAL(adapter);
  assert.ok(failed.failure);
  const unchanged: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(unchanged.issues.find((i) => i.id === issue.id)!.status, 'triaged', '问题单保留原值');
  assert.equal(unchanged.records.length, seed.records.length, '处理记录也没有写入');
  const walAfterFail = JSON.parse(adapter.wal!) as PendingOperation[];
  assert.equal(walAfterFail.length, 1);
  assert.ok(walAfterFail[0].lastError);

  // 人工重试成功
  const retry = commitWAL(adapter);
  assert.deepEqual(retry.applied.length >= 1, true);
  const applied: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(applied.issues.find((i) => i.id === issue.id)!.status, 'fixing');
  assert.equal(applied.records.length, seed.records.length + 1, '处理记录与问题单同一次写入');
  assert.equal(adapter.wal, null, '成功后清空 WAL');
});

await test('重开后自动续传恰好一次', () => {
  const { adapter, seed } = freshEnv();
  const issue = seed.issues.find((i) => i.id === 'issue-1')!;
  const base = snapshotOf(issue);
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员甲', base, patch: { status: 'fixing' } }));
  // 重开时磁盘仍故障
  adapter.failures = 10;
  const firstResume = resumeWAL(adapter);
  assert.ok(firstResume?.failure);
  const wal1 = JSON.parse(adapter.wal!) as PendingOperation[];
  assert.equal(wal1[0].resumed, true, '续传前先标记，崩溃也不会再自动续');
  assert.equal(wal1[0].attempts, 2);

  // 磁盘恢复：再次“重开”不会自动续传（已续过一次）
  adapter.failures = 0;
  const secondResume = resumeWAL(adapter);
  assert.equal(secondResume, null);
  const wal2 = JSON.parse(adapter.wal!) as PendingOperation[];
  assert.equal(wal2.length, 1, '操作仍在队列，等待人工重试');

  // 人工重试成功
  const manual = commitWAL(adapter);
  assert.equal(manual.applied.length, 1);
  assert.equal(adapter.wal, null);
});

await test('续传/重放幂等：同一操作不会产生重复处理记录', () => {
  const { adapter, seed } = freshEnv();
  stageOperation(adapter, buildSaveOp({
    id: 'op-dup', issueId: 'issue-1', by: '审核员甲', base: snapshotOf(seed.issues.find((i) => i.id === 'issue-1')!),
    patch: { status: 'fixing' }
  }));
  commitWAL(adapter);
  // WAL 被外部重复保留（如清理失败），再放一次
  adapter.wal = JSON.stringify([{
    id: 'op-dup', type: 'save', issueId: 'issue-1', by: '审核员甲', createdAt: new Date().toISOString(),
    attempts: 1, resumed: true, base: snapshotOf(seed.issues.find((i) => i.id === 'issue-1')!),
    patch: { status: 'fixing' }, kind: 'fix-start', message: 'x'
  }]);
  commitWAL(adapter);
  const doc: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(doc.records.filter((r) => r.opId === 'op-dup').length, 1);
});

await test('新挂的合并关系经多跳链接也回到最终问题单（含反向悬挂）', () => {
  const { adapter } = freshEnv();
  // 把 issue-1 挂到 issue-4 上，最终根应仍是 issue-2，且所有旧链接被压缩
  stageOperation(adapter, { id: 'merge-1', type: 'merge', sourceId: 'issue-1', targetId: 'issue-4', by: '审核员甲', createdAt: new Date().toISOString(), attempts: 0, resumed: false });
  commitWAL(adapter);
  const doc: CollabDoc = JSON.parse(adapter.doc!);
  assert.equal(resolveRoot(doc.mergeLinks, 'issue-1').root, 'issue-2');
  assert.deepEqual(doc.mergeLinks, { 'issue-1': 'issue-2', 'issue-3': 'issue-2', 'issue-4': 'issue-2' });
  assert.ok(doc.records.some((r) => r.kind === 'merge' && r.mergeTargetId === 'issue-2'));
});

await test('重复合并到同一最终单：幂等跳过，不重复写处理记录', () => {
  const { adapter } = freshEnv();
  // issue-1 当前是根，挂到 issue-2 后应成功
  const op: PendingOperation = { id: 'm-1', type: 'merge', sourceId: 'issue-1', targetId: 'issue-2', by: '甲', createdAt: new Date().toISOString(), attempts: 0, resumed: false };
  stageOperation(adapter, op);
  const r1 = commitWAL(adapter);
  assert.deepEqual(r1.skipped, []);
  assert.deepEqual(r1.applied, ['m-1']);
  const recordsAfter = JSON.parse(adapter.doc!).records.length;
  // 再合一次（同一最终根）：跳过，处理记录不增加
  stageOperation(adapter, { ...op, id: 'm-2' });
  const r2 = commitWAL(adapter);
  assert.deepEqual(r2.skipped, ['m-2']);
  assert.equal(JSON.parse(adapter.doc!).records.length, recordsAfter);
});

await test('创建问题同样经过 WAL，文档失败时不出现在列表', () => {
  const adapter = new MemoryAdapter();
  adapter.doc = JSON.stringify(seedDoc());
  stageOperation(adapter, {
    id: 'c-1', type: 'create', issueId: 'issue-new', by: '审核员甲', createdAt: new Date().toISOString(),
    attempts: 0, resumed: false,
    fields: { title: '新问题标题示例', flow: '业务流程', steps: '复现步骤内容', impactGroup: '键盘用户', severity: 'minor' }
  });
  adapter.failures = 1;
  const fail = commitWAL(adapter);
  assert.ok(fail.failure);
  assert.equal(readDoc(adapter).issues.some((i) => i.id === 'issue-new'), false);
  commitWAL(adapter);
  assert.equal(readDoc(adapter).issues.some((i) => i.id === 'issue-new'), true);
});

await test('不冲突的并发修订自动合并（不同字段）', () => {
  const { adapter, seed } = freshEnv();
  const issue = seed.issues.find((i) => i.id === 'issue-1')!;
  const base = snapshotOf(issue);
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员甲', base, patch: { fixNote: '甲补修复说明' } }));
  commitWAL(adapter);
  stageOperation(adapter, buildSaveOp({ issueId: issue.id, by: '审核员乙', base, patch: { retestNote: '乙补复测说明' } }));
  const report = commitWAL(adapter);
  assert.equal(report.conflicted.length, 0);
  const doc: CollabDoc = JSON.parse(adapter.doc!);
  const after = doc.issues.find((i) => i.id === issue.id)!;
  assert.equal(after.fixNote, '甲补修复说明');
  assert.equal(after.retestNote, '乙补复测说明');
  assert.ok(doc.records.at(-1)!.message.includes('自动合并'));
});

console.log(`\n${passed} 个测试全部通过`);
