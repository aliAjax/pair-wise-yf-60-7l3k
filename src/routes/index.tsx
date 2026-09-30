import { For, Show, createMemo, createSignal } from 'solid-js';
import { createForm, reset, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  AuditIssue,
  FIELD_LABELS,
  IssueStatus,
  PendingConflict,
  ReviewerChoice,
  STATUS_LABELS,
  WorkflowField,
  WorkflowSnapshot,
  isDuplicate,
  rootOf,
  snapshotOf,
  unresolvedConflicts
} from '../lib/collab';
import { createCollabStore } from '../lib/useCollabStore';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '同一份可恢复协作数据：问题单 · 处理记录 · 合并关系', issues: '审计问题', merge: '重复合并', events: '处理记录时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'One recoverable collaboration document', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const valueOrDash = (v: string | undefined) => (v && v.length ? v : '（空）');

export default function AuditWorkbench() {
  const collab = createCollabStore();
  const { doc, actions, reviewer } = collab;
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));

  const [selectedId, setSelectedId] = createSignal(doc.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');

  // 本地工作副本：审核员打开问题单时所见的旧版本（保存时作为三方比对的 base）
  const initialIssue = doc.issues[0];
  const [base, setBase] = createSignal<WorkflowSnapshot>(initialIssue ? snapshotOf(initialIssue) : { status: 'open', fixNote: '', retestNote: '' });
  const [draftFix, setDraftFix] = createSignal(initialIssue?.fixNote ?? '');
  const [draftRetest, setDraftRetest] = createSignal(initialIssue?.retestNote ?? '');

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => doc.issues.find((issue) => issue.id === selectedId()) ?? doc.issues.find((i) => !isDuplicate(doc, i.id)));

  const selectIssue = (id: string) => {
    setSelectedId(id);
    setMergeInto('');
    adoptBase(doc.issues.find((i) => i.id === id));
  };
  // 选中问题时，把当前头部版本记为“我的旧版本”基线（保存前据此三方比对）
  function adoptBase(issue: AuditIssue | undefined) {
    if (!issue) return;
    setBase(snapshotOf(issue));
    setDraftFix(issue.fixNote);
    setDraftRetest(issue.retestNote);
  }

  const root = createMemo(() => (selected() ? rootOf(doc, selected()!.id) : null));
  const rootIssue = createMemo(() => (root() ? doc.issues.find((i) => i.id === root()!.root) : undefined));
  const selectedConflicts = createMemo(() => (selected() ? unresolvedConflicts(doc, selected()!.id) : []));
  const allUnresolved = createMemo(() => doc.conflicts.filter((c) => !c.resolvedAt));
  const issueRecords = createMemo(() =>
    selected()
      ? doc.records.filter((r) => r.issueId === selected()!.id || r.mergeTargetId === selected()!.id).slice(-30).reverse()
      : []
  );
  const recentRecords = createMemo(() => doc.records.slice(-14).reverse());

  const savePatch = (patch: Partial<WorkflowSnapshot>, message?: string) => {
    const issue = selected();
    if (!issue) return;
    const report = actions.saveWorkflow({ issueId: issue.id, base: base(), patch, message });
    const after = report?.doc.issues.find((x) => x.id === issue.id);
    // 保存后我的基线前移到最新头部（失败时 report.doc 是旧值，基线不动，可重试）
    if (after && !report?.failure) adoptBase(after);
  };

  const saveNotes = () => {
    const patch: Partial<WorkflowSnapshot> = {};
    if (draftFix() !== base().fixNote) patch.fixNote = draftFix();
    if (draftRetest() !== base().retestNote) patch.retestNote = draftRetest();
    if (Object.keys(patch).length === 0) return;
    savePatch(patch, `${reviewer()}保存修复/复测说明`);
  };

  const createIssue = (values: IssueForm) => {
    actions.createIssue(values);
    reset(form);
  };

  const mergeDuplicate = () => {
    const duplicate = selected();
    if (!duplicate || !mergeInto()) return;
    actions.merge(duplicate.id, mergeInto());
    setMergeInto('');
  };

  const stats = createMemo(() => ({
    total: doc.issues.length,
    pending: doc.issues.filter((issue) => ['open', 'triaged', 'fixing', 'reopened'].includes(issue.status)).length,
    verifying: doc.issues.filter((issue) => issue.status === 'verifying').length,
    closed: doc.issues.filter((issue) => issue.status === 'closed').length
  }));

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">同一份可恢复协作数据（问题单 + 处理记录 + 合并关系）</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 保存前比对修订号，冲突双份留存待选定，写入失败保留原值可重试</p>
          </div>
          <div style={{ display: 'flex', gap: '10px', 'align-items': 'center' }}>
            <label style={{ 'font-weight': '400' }}>当前审核员
              <select value={reviewer()} onChange={(e) => collab.changeReviewer(e.currentTarget.value)}>
                <option>审核员甲</option><option>审核员乙</option><option>审核员丙</option>
              </select>
            </label>
            <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
          </div>
        </header>

        <Show when={collab.staleNotice()}>
          <div class="banner warn" role="status">
            同一份协作文档已被其他会话/审核员更新（问题单修订号已前进）。继续基于旧版本保存将触发保存前比对；
            <button class="secondary" style={{ margin: '0 8px' }} onClick={() => { const id = selectedId(); collab.setStaleNotice(false); const latest = collab.issueById()(id); if (latest) adoptBase(latest); }}>我知道了，刷新我的基线</button>
          </div>
        </Show>

        <div class="toasts" aria-live="polite">
          <For each={collab.toasts}>{(toast) => <div class={`toast ${toast.kind}`} role="status">{toast.text}</div>}</For>
        </div>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>全部问题</span><strong>{stats().total}</strong></div>
          <div class="card"><span>待处理</span><strong>{stats().pending}</strong></div>
          <div class="card"><span>待复测</span><strong>{stats().verifying}</strong></div>
          <div class="card"><span>已关闭 / 待裁定冲突</span><strong>{stats().closed} / {allUnresolved().length}</strong></div>
        </section>

        <Show when={allUnresolved().length > 0}>
          <div class="banner danger" role="alert">
            有 {allUnresolved().length} 处字段冲突尚未选定；相关问题单在全部选定前不能关闭。请在下方「冲突裁定」中逐字段选择保留哪一份修订。
          </div>
        </Show>
        <Show when={collab.wal.length > 0}>
          <PendingOutbox wal={collab.wal} onRetry={actions.retryAll} onDiscard={actions.discardOp} />
        </Show>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')}</h2>
            <For each={doc.issues}>{(issue) => {
              const r = rootOf(doc, issue.id);
              const conflicts = unresolvedConflicts(doc, issue.id);
              return (
                <article class="issue">
                  <h3>
                    <button class="secondary" onClick={() => selectIssue(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>
                      {issue.title}
                      <Show when={conflicts.length}><span class="badge danger-badge">冲突×{conflicts.length}</span></Show>
                    </button>
                  </h3>
                  <div class="meta">
                    <span class="badge">{STATUS_LABELS[issue.status]}</span>
                    <span class="badge">rev {issue.rev}</span>
                    <span class="badge">{issue.severity}</span>
                    <span>{issue.flow}</span>
                    <Show when={r.root !== issue.id}><span class="badge">已合并 → 最终单 {r.root}</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>
              {(issue) => {
                const i = createMemo(() => doc.issues.find((x) => x.id === issue().id) ?? issue());
                return <>
                  <h3>{i().title}</h3>
                  <p class="meta"><span class="badge">{STATUS_LABELS[i().status]}</span><span class="badge">修订号 rev {i().rev}</span><span class="badge">{i().severity}</span></p>
                  <p><strong>业务流程：</strong>{i().flow}</p>
                  <p><strong>受影响人群：</strong>{i().impactGroup}</p>
                  <p><strong>复现步骤：</strong>{i().steps}</p>

                  <Show when={root() && root()!.root !== i().id}>
                    <div class="banner warn">
                      合并链路：
                      <For each={root()!.chain}>{(node, idx) => (
                        <span>{idx() > 0 ? ' → ' : ''}<button class="link-btn" onClick={() => selectIssue(node)}>{node}</button></span>
                      )}</For>
                      （无论几层，旧链接都直接回到最终问题单 <button class="link-btn" onClick={() => selectIssue(root()!.root)}>{root()!.root}</button>
                      ：{rootIssue()?.title}）
                    </div>
                  </Show>

                  <p><strong>修复记录（头部）：</strong>{i().fixNote || '尚未填写'}</p>
                  <p><strong>复测记录（头部）：</strong>{i().retestNote || '尚未填写'}</p>

                  <fieldset class="workflow">
                    <legend>保存处理记录（问题单状态与说明随处理记录一次原子写入）</legend>
                    <label>修复说明<textarea rows={2} value={draftFix()} onInput={(e) => setDraftFix(e.currentTarget.value)} /></label>
                    <label>复测说明<textarea rows={2} value={draftRetest()} onInput={(e) => setDraftRetest(e.currentTarget.value)} /></label>
                    <div role="group" aria-label="问题状态操作">
                      <button onClick={() => savePatch({ status: 'triaged' }, '审核员完成分诊')}>确认问题</button>{' '}
                      <button onClick={() => savePatch({ status: 'fixing' }, '开发人员开始修复')}>开始修复</button>{' '}
                      <button onClick={saveNotes}>保存说明</button>{' '}
                      <button onClick={() => savePatch({ status: 'verifying' }, '开发人员提交修复，进入复测')}>提交复测</button>{' '}
                      <button onClick={() => savePatch({ status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>复测通过并关闭</button>{' '}
                      <button class="danger" onClick={() => savePatch({ status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>复测失败重开</button>
                    </div>
                    <p class="hint">保存基线（我打开时的旧版本）：{STATUS_LABELS[base().status]} · 修复说明 {valueOrDash(base().fixNote)} · 复测说明 {valueOrDash(base().retestNote)}</p>
                  </fieldset>

                  <ConflictPanel
                    conflicts={selectedConflicts()}
                    onResolve={(conflictId, choices) => {
                      const report = actions.resolveConflict(conflictId, choices);
                      const after = selected() && report ? report.doc.issues.find((x) => x.id === selected()!.id) : undefined;
                      if (after && report && !report.failure && report.rejected.length === 0) adoptBase(after);
                    }}
                  />

                  <hr />
                  <label>合并到最终主问题
                    <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                      <option value="">选择问题（仅列出未被合并的最终单）</option>
                      <For each={doc.issues.filter((item) => {
                        const r1 = rootOf(doc, item.id);
                        return r1.root !== i().id && r1.root === item.id;
                      })}>{(item) => <option value={item.id}>{item.title}（{item.id}）</option>}</For>
                    </select>
                  </label>
                  <button disabled={!mergeInto()} onClick={mergeDuplicate}>确认重复合并（旧链路一并压到最终单）</button>
                </>;
              }}
            </Show>
          </section>
        </div>

        <div class="grid" style={{ 'margin-top': '18px' }}>
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createIssue} style={{ 'margin-top': '12px' }}>
              <AuditField name="title">{ (field, props) => {
                const f = field as unknown as { value: string; error?: string };
                return <label>问题标题<input id="issue-title" {...props} value={f.value} onInput={(event) => { f.value = event.currentTarget.value; }} aria-invalid={f.error ? 'true' : undefined} aria-describedby={f.error ? 'title-error' : undefined} /><Show when={f.error}><p class="error" id="title-error" role="alert">{f.error}</p></Show></label>;
              } }</AuditField>
              <AuditField name="flow">{ (field, props) => {
                const f = field as unknown as { value: string };
                return <label>业务流程<input {...props} value={f.value} onInput={(event) => { f.value = event.currentTarget.value; }} /></label>;
              } }</AuditField>
              <AuditField name="steps">{ (field, props) => {
                const f = field as unknown as { value: string };
                return <label>复现步骤<textarea {...props} rows={3} value={f.value} onInput={(event) => { f.value = event.currentTarget.value; }} /></label>;
              } }</AuditField>
              <AuditField name="impactGroup">{ (field) => {
                const f = field as unknown as { value: string };
                return <label>影响人群<select value={f.value} onChange={(event) => { f.value = event.currentTarget.value; }}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label>;
              } }</AuditField>
              <AuditField name="severity">{ (field) => {
                const f = field as unknown as { value: IssueForm['severity'] };
                return <label>严重程度<select value={f.value} onChange={(event) => { f.value = event.currentTarget.value as IssueForm['severity']; }}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label>;
              } }</AuditField>
              <button type="submit">创建问题（原子写入并追加处理记录）</button>
            </AuditForm>

            <hr />
            <h2>协作演练工具</h2>
            <p class="hint">单机演示两位审核员并发：先点“模拟他改状态/修复说明”制造头部新版本，再用上方状态按钮基于旧版本保存，即可看到双份留存与关闭护栏。也可打开两个浏览器标签页真实并发编辑（自动跨页同步）。</p>
            <div role="group" aria-label="演练工具" style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px' }}>
              <Show when={selected()} fallback={<span class="hint">请先选择问题单</span>}>
                <button class="secondary" onClick={() => actions.simulateRemoteSave({ issueId: selected()!.id, patch: { status: 'verifying', fixNote: '对方：已修复并提交复测版本' } })}>模拟他改「状态+修复说明」</button>
                <button class="secondary" onClick={() => actions.simulateRemoteSave({ issueId: selected()!.id, patch: { retestNote: '对方：复测通过，可关闭' } })}>模拟他改「复测说明」（不同字段，自动合并）</button>
                <button class="danger" onClick={() => actions.failNextWrite(1)}>模拟下一次写入失败</button>
              </Show>
            </div>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List>
                <Tabs.Trigger value="activity">当前问题处理记录</Tabs.Trigger>
                <Tabs.Trigger value="all">全局时间线</Tabs.Trigger>
                <Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger>
              </Tabs.List>
              <Tabs.Content value="activity">
                <div class="timeline" aria-live="polite">
                  <For each={issueRecords()} fallback={<p class="hint">暂无处理记录</p>}>{(rec) => (
                    <div style={{ 'margin-bottom': '12px' }}>
                      <strong>{new Date(rec.at).toLocaleString()} · {rec.by}</strong>
                      <div>{rec.message}</div>
                      <div class="hint">类型：{rec.kind}<Show when={rec.mergeTargetId}> · 最终合并到 {rec.mergeTargetId}</Show><Show when={rec.conflictId}> · 冲突 {rec.conflictId}</Show></div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="all">
                <div class="timeline">
                  <For each={recentRecords()}>{(rec) => (
                    <div style={{ 'margin-bottom': '10px' }}>
                      <strong>{new Date(rec.at).toLocaleString()} · {rec.issueId}</strong>
                      <div>{rec.message}（{rec.by}）</div>
                    </div>
                  )}</For>
                </div>
              </Tabs.Content>
              <Tabs.Content value="keyboard"><ul>
                <li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li>
                <li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li>
                <li>冲突面板每一字段都必须用单选钮选定一份修订，才能提交裁定</li>
                <li>所有错误与写入失败消息使用 <code>role="alert"</code> / <code>role="status"</code></li>
              </ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}

function ConflictPanel(props: {
  conflicts: PendingConflict[];
  onResolve: (conflictId: string, choices: { field: WorkflowField; choice: ReviewerChoice }[]) => void;
}) {
  const choicesFor = (conflict: PendingConflict) => {
    const map = new Map<WorkflowField, ReviewerChoice>();
    return {
      set: (field: WorkflowField, choice: ReviewerChoice) => map.set(field, choice),
      get: () => conflict.fields.map((f) => ({ field: f.field, choice: map.get(f.field) as ReviewerChoice })),
      size: () => map.size
    };
  };

  return (
    <Show when={props.conflicts.length > 0}>
      <section class="conflict-box" aria-label="冲突裁定">
        <h3>⚠️ 保存前比对：以下字段与他人修订冲突（两份都已保留）</h3>
        <p class="hint">未逐字段选定前，本问题单不能关闭。选定后问题单与一条「冲突裁定」处理记录一起写入。</p>
        <For each={props.conflicts}>{(conflict) => {
          const holder = choicesFor(conflict);
          return (
            <fieldset class="conflict">
              <legend>冲突 {conflict.id} · 基于 rev {conflict.baseRev} · 发现于 {new Date(conflict.detectedAt).toLocaleString()}</legend>
              <For each={conflict.fields}>{(c) => (
                <fieldset class="field-choice">
                  <legend>字段：{FIELD_LABELS[c.field]}<Show when={c.field === 'status'}>（{STATUS_LABELS[c.mine as IssueStatus]} / {STATUS_LABELS[c.theirs as IssueStatus]}）</Show></legend>
                  <label class="choice">
                    <input type="radio" name={`${conflict.id}-${c.field}`}
                      onChange={() => holder.set(c.field, 'mine')} />
                    <span><strong>保留我方修订</strong>（{c.mineBy} · {new Date(c.mineAt).toLocaleString()}）：<code>{displayValue(c.field, c.mine)}</code></span>
                  </label>
                  <label class="choice">
                    <input type="radio" name={`${conflict.id}-${c.field}`}
                      onChange={() => holder.set(c.field, 'theirs')} />
                    <span><strong>采用对方修订（当前头部）</strong>（{c.theirsBy} · {new Date(c.theirsAt).toLocaleString()}）：<code>{displayValue(c.field, c.theirs)}</code></span>
                  </label>
                </fieldset>
              )}</For>
              <button onClick={() => {
                const choices = holder.get();
                if (holder.size() !== conflict.fields.length) {
                  alert('请为每个冲突字段选定一份修订');
                  return;
                }
                props.onResolve(conflict.id, choices);
              }}>提交裁定（{conflict.fields.length} 个字段全部选定）</button>
            </fieldset>
          );
        }}</For>
      </section>
    </Show>
  );
}

function displayValue(field: WorkflowField, v: string): string {
  if (field === 'status') return STATUS_LABELS[v as IssueStatus] ?? v;
  return v.length ? v : '（空）';
}

function PendingOutbox(props: {
  wal: ReturnType<typeof createCollabStore>['wal'];
  onRetry: () => void;
  onDiscard: (opId: string) => void;
}) {
  return (
    <section class="banner error-banner" aria-label="待办写入队列">
      <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', gap: '12px', 'flex-wrap': 'wrap' }}>
        <strong>待写入操作（WAL）：{props.wal.length} 项 —— 文档未被这些操作改变，重开后自动续传一次，之后可在此手动重试</strong>
        <button onClick={props.onRetry}>立即重试全部</button>
      </div>
      <ul class="wal-list">
        <For each={[...props.wal].reverse()}>{(op) => (
          <li>
            <code>{op.type}</code> · {op.by} · 尝试 {op.attempts} 次
            <Show when={op.resumed}><span class="badge">已用重开自动续传</span></Show>
            <Show when={op.type === 'save'}><span>问题 {(op as { issueId: string }).issueId}：{(op as { message: string }).message}</span></Show>
            <Show when={op.type === 'create'}><span>新建问题 {(op as { issueId: string }).issueId}</span></Show>
            <Show when={op.type === 'merge'}><span>合并 {(op as { sourceId: string }).sourceId} → {(op as { targetId: string }).targetId}</span></Show>
            <Show when={op.type === 'resolve'}><span>裁定冲突 {(op as { conflictId: string }).conflictId}</span></Show>
            <Show when={op.lastError}><span class="error" role="alert">失败原因：{op.lastError}</span></Show>
            <button class="danger small" onClick={() => props.onDiscard(op.id)}>放弃该操作</button>
          </li>
        )}</For>
      </ul>
    </section>
  );
}
