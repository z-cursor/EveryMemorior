"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConfigButton } from "./SettingsUi";
import { AdminBadge, AdminCard, AdminEmpty, AdminFeedback, adminDate, membershipLabels } from "./CompanionAdminUi";
import { AgentCommandError, sendAgentCommand } from "@/lib/agent-client";
import {
  normalizeTenantOverview,
  readTenantJsonResponse,
  type TenantOverview,
  type TenantRole as Role,
} from "@/lib/tenant-overview";

type TenantSkillView = {
  id: string;
  name: string;
  description: string;
  status: "draft" | "pending_review" | "published" | "suspended" | "archived";
  version: number;
  imageDigest?: string | null;
  lockfileDigest?: string | null;
  runtimeProfile?: string | null;
  buildStatus?: "pending" | "building" | "ready" | "failed";
  buildError?: string | null;
};

function digestPreview(value: string | null | undefined): string {
  return value ? `${value.slice(0, 19)}…` : "—";
}

async function jsonRequest<T = Record<string, unknown>>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  return readTenantJsonResponse<T>(response);
}

export function TenantSettings({ onOpenQuality, sessionId, onSessionReloaded }: { onOpenQuality?: () => void; sessionId?: string | null; onSessionReloaded?: () => void }) {
  const [data, setData] = useState<TenantOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState({ email: "", role: "member" as Role });
  const [inviteLink, setInviteLink] = useState("");
  const [tenantDraft, setTenantDraft] = useState({ tenantName: "", tenantSlug: "" });
  const [skills, setSkills] = useState<TenantSkillView[]>([]);
  const [skillFile, setSkillFile] = useState<File | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invitedEmail, setInvitedEmail] = useState("");
  const [invitedRole, setInvitedRole] = useState<Role>("member");
  const [search, setSearch] = useState("");
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillsError, setSkillsError] = useState("");
  const inviteEmailRef = useRef<HTMLInputElement>(null);
  const inviteLinkRef = useRef<HTMLInputElement>(null);
  const skillFileInputRef = useRef<HTMLInputElement>(null);
  const operationRef = useRef(false);
  const skillsLoadRef = useRef(false);

  useEffect(() => { if (inviteOpen) inviteEmailRef.current?.focus(); }, [inviteOpen]);

  const load = useCallback(async () => {
    try {
      const overview = await jsonRequest("/api/tenant", { cache: "no-store" });
      setData(normalizeTenantOverview(overview));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const loadSkills = useCallback(async () => {
    if (skillsLoadRef.current) return;
    skillsLoadRef.current = true;
    setSkillsError("");
    try {
      const view = data?.canManage ? "?view=governance" : "";
      const result = await jsonRequest<{ skills?: TenantSkillView[] }>(`/api/tenant/skills${view}`, { cache: "no-store" });
      setSkills(result.skills ?? []);
      setSkillsLoaded(true);
    } catch (cause) {
      setSkillsError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      skillsLoadRef.current = false;
    }
  }, [data?.canManage]);

  useEffect(() => {
    if (data && !skillsLoaded && !skillsError) void loadSkills();
  }, [data, skillsLoaded, skillsError, loadSkills]);

  const copyInvitation = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setNotice("邀请链接已复制。请在无痕窗口中打开，或安全地发给受邀成员。");
    } catch {
      inviteLinkRef.current?.focus();
      inviteLinkRef.current?.select();
      setNotice("浏览器未允许自动复制。链接已选中，请按 Ctrl+C 或使用系统复制菜单。");
    }
  };

  const run = async (operation: () => Promise<void>) => {
    if (operationRef.current) return;
    operationRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(); } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { operationRef.current = false; setBusy(false); }
  };

  const reloadSkillResources = async () => {
    if (!sessionId) return;
    try {
      // Publishing or suspending a Tenant Skill changes the resource paths
      // captured when the AgentSession was constructed. Ask the server to
      // rebuild this idle session with the current published set.
      await sendAgentCommand(sessionId, { type: "reload", refreshTenantSkills: true });
      onSessionReloaded?.();
    } catch (cause) {
      if (cause instanceof AgentCommandError && cause.status === 409) {
        setNotice("当前会话正在回复；回复结束后再次点击“刷新技能列表”即可在当前会话调用。");
      } else {
        setNotice(`刷新 Skill 列表失败：${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  };

  const refreshSkills = async () => {
    await loadSkills();
    await reloadSkillResources();
  };

  const switchTenant = (tenantId: string) => run(async () => {
    await jsonRequest("/api/web-auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "switch-organization", tenantId }),
    });
    window.location.replace("/");
  });

  const createTenant = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await jsonRequest("/api/web-auth", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-organization", ...tenantDraft }),
      });
      window.location.replace("/");
    });
  };

  const createInvitation = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await jsonRequest<{ token: string; invitationUrl?: string }>("/api/tenant", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(invite),
      });
      const link = result.invitationUrl ?? `${window.location.origin}/login?invite=${encodeURIComponent(String(result.token))}`;
      setInviteLink(link);
      setInvitedEmail(invite.email);
      setInvitedRole(invite.role);
      setInvite({ email: "", role: "member" });
      setNotice("邀请已创建，请把链接安全地发送给受邀用户。");
      await load();
    });
  };

  const updateRole = (membershipId: string, role: Role) => {
    const member = data?.members.find((item) => item.membershipId === membershipId);
    if (!member || !window.confirm(`将 ${member.displayName} 从${membershipLabels[member.role]}改为${membershipLabels[role]}？\n这会改变该成员在当前租户的权限与首页界面。`)) return;
    void run(async () => {
      await jsonRequest("/api/tenant", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ membershipId, role }),
      });
      setNotice("成员角色已更新。该成员刷新页面后会使用新的身份。");
      await load();
      if (membershipId === data?.currentMembership.id) window.location.reload();
    });
  };

  const revokeInvitation = (id: string) => run(async () => {
    await jsonRequest(`/api/tenant?invitationId=${encodeURIComponent(id)}`, { method: "DELETE" });
    setNotice("邀请已撤销。");
    await load();
  });

  const uploadSkill = (event: FormEvent) => {
    event.preventDefault();
    if (!skillFile) return;
    void run(async () => {
      const form = new FormData();
      form.set("file", skillFile);
      const result = await jsonRequest<{ skill?: TenantSkillView }>("/api/tenant/skills", { method: "POST", body: form });
      setSkillFile(null);
      if (skillFileInputRef.current) skillFileInputRef.current.value = "";
      setNotice(result.skill?.status === "published" ? "声明式 Skill 已启用，可在当前或新会话中调用。" : result.skill?.status === "suspended" ? "Skill 已存在但目前停用，请点击恢复。" : "Skill 草稿已上传，请提交审核。");
      await loadSkills();
      await reloadSkillResources();
    });
  };

  const changeSkillStatus = (skillId: string, action: "submit" | "publish" | "suspend" | "resume" | "build" | "retry") => run(async () => {
    await jsonRequest("/api/tenant/skills", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skillId, action }),
    });
    setNotice(action === "publish" ? "Skill 已发布。" : action === "suspend" ? "Skill 已停用。" : action === "resume" ? "Skill 已恢复。" : action === "build" || action === "retry" ? "运行时构建已开始。" : "Skill 已提交审核。");
    await loadSkills();
    await reloadSkillResources();
  });

  const deleteSkill = (skill: TenantSkillView) => {
    if (!window.confirm(`删除 Skill「${skill.name}」？删除后将无法在当前租户中使用。`)) return;
    void run(async () => {
      await jsonRequest(`/api/tenant/skills?skillId=${encodeURIComponent(skill.id)}`, { method: "DELETE" });
      setNotice("Skill 已删除。");
      await loadSkills();
      await reloadSkillResources();
    });
  };

  if (!data) return (
    <div className="admin-settings"><div className="admin-content">
      <AdminFeedback error={error} pending={error ? null : "正在加载团队与成员…"} />
      {error && <ConfigButton onClick={() => void load()}>重新加载成员</ConfigButton>}
    </div></div>
  );

  const filteredMembers = data.members.filter((member) => `${member.displayName} ${member.email}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const roleOptions = (includeOwner: boolean) => (<>
    <option value="member">{membershipLabels.member}</option>
    <option value="admin">{membershipLabels.admin}</option>
    {includeOwner && <option value="owner">{membershipLabels.owner}</option>}
  </>);

  if (!data.canManage) return (
    <div className="admin-settings" aria-label="账号与个人设置">
      <div className="admin-content">
        <header className="admin-header">
          <div>
            <span className="admin-eyebrow">我的账号 · {data.tenant.name}</span>
            <h2>账号与个人设置</h2>
            <p>这里显示你在当前团队中的账号身份；成员管理和邀请由管理员负责。</p>
          </div>
          <ConfigButton disabled={busy} onClick={() => void load()}>刷新</ConfigButton>
        </header>
        <AdminFeedback error={error} notice={notice} pending={busy ? "正在保存，请稍候…" : null} />
        <AdminCard title="我的账号" description="仅显示当前登录账号，不展示其他成员信息。">
          <dl className="admin-account-facts">
            <div><dt>姓名</dt><dd>{data.members.find((item) => item.membershipId === data.currentMembership.id)?.displayName ?? "—"}</dd></div>
            <div><dt>邮箱</dt><dd>{data.members.find((item) => item.membershipId === data.currentMembership.id)?.email ?? "—"}</dd></div>
            <div><dt>当前角色</dt><dd><AdminBadge>{membershipLabels[data.currentMembership.role]}</AdminBadge></dd></div>
            <div><dt>团队</dt><dd>{data.tenant.name}</dd></div>
          </dl>
        </AdminCard>
        <AdminCard title="我的 Skills" description="你上传的 Skill 只属于自己的账号。含脚本的 Skill 需审核后才能使用。">
          <div className="admin-skill-content">
            <p className="admin-help">可用预置 Skill：Tavily Search、Ponytail。个人 Skill 上传后仅当前账号可见。</p>
            {skillsError && <><AdminFeedback error={skillsError} /><ConfigButton onClick={() => void loadSkills()}>重新加载 Skills</ConfigButton></>}
            {!skillsLoaded && !skillsError && <p className="admin-help">正在读取个人 Skills…</p>}
            {skillsLoaded && (
              <div className="admin-skill-list">
                {skills.length === 0 && <p className="admin-help">还没有上传个人 Skill。</p>}
                {skills.map((skill) => <div key={skill.id} className="admin-row">
                  <div><strong>{skill.name} · v{skill.version}</strong><p className="admin-help">{skill.status}{skill.buildStatus ? ` · 运行时 ${skill.buildStatus}` : ""}{skill.runtimeProfile ? ` · ${skill.runtimeProfile}` : ""}</p>{(skill.imageDigest || skill.lockfileDigest) && <p className="admin-help">image {digestPreview(skill.imageDigest)} · lock {digestPreview(skill.lockfileDigest)}</p>}{skill.buildError && <p className="admin-help">{skill.buildError}</p>}</div>
                  <div className="admin-actions">
                    {skill.status === "draft" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, "submit")}>提交审核</ConfigButton>}
                    {skill.status === "published" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, "suspend")}>停用</ConfigButton>}
                    {skill.status === "suspended" && <>
                      {data.canManage && skill.buildStatus !== "ready" && skill.buildStatus !== "building" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, skill.buildStatus === "failed" ? "retry" : "build")}>构建运行时</ConfigButton>}
                      {data.canManage && <ConfigButton disabled={busy || (skill.buildStatus !== undefined && skill.buildStatus !== "ready")} title={skill.buildStatus !== "ready" ? "运行时构建完成后才能恢复" : undefined} onClick={() => void changeSkillStatus(skill.id, "resume")}>恢复</ConfigButton>}
                    </>}
                    <ConfigButton variant="ghost" disabled={busy} onClick={() => deleteSkill(skill)}>删除</ConfigButton>
                  </div>
                </div>)}
              </div>
            )}
            <form onSubmit={uploadSkill} className="admin-skill-upload">
              <label className="admin-field admin-skill-file">上传 Skill ZIP
                <span className="admin-file-picker"><span>选择 ZIP 文件</span><span>{skillFile?.name ?? "未选择文件"}</span></span>
                <input ref={skillFileInputRef} id="tenant-skill-file" className="admin-file-input" type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => setSkillFile(event.target.files?.[0] ?? null)} />
              </label>
              <ConfigButton type="submit" variant="primary" disabled={busy || !skillFile}>上传 Skill</ConfigButton>
            </form>
          </div>
        </AdminCard>
      </div>
    </div>
  );

  return (
    <div className="admin-settings" aria-label="用户与权限管理">
      <div className="admin-content">
        <header className="admin-header">
          <div>
            <span className="admin-eyebrow">当前团队 · {data.tenant.name}</span>
            <h2>用户与权限</h2>
            <p>管理成员、租户角色与他们进入的工作界面。{membershipLabels[data.currentMembership.role]} · {data.members.length} 位成员 · 席位{data.tenant.seatLimit == null ? "未限制" : `上限 ${data.tenant.seatLimit}`}</p>
          </div>
          <div className="admin-header-actions">
            <ConfigButton disabled={busy} onClick={() => void load()}>刷新成员</ConfigButton>
            {data.canManage && <ConfigButton variant="primary" aria-expanded={inviteOpen} aria-controls="member-invitation" onClick={() => { setInvite((value) => ({ ...value, role: "member" })); setInviteOpen(true); }}>＋ 邀请陪伴成员</ConfigButton>}
          </div>
        </header>
        <AdminFeedback error={error} notice={notice} pending={busy ? "正在保存，请稍候…" : null} />

        <aside className="admin-guide" aria-label="陪伴界面体验指引">
          <span className="admin-guide-number" aria-hidden="true">?</span>
          <div className="admin-guide-copy">
            <strong>想查看凡小忆的陪伴界面？无需更改管理员身份</strong>
            <p>邀请另一个邮箱为 Member → 在无痕窗口接受邀请 → 登录后进入陪伴对话。Admin / Owner 使用管理工作台。</p>
          </div>
        </aside>

        {data.canManage && inviteOpen && <div id="member-invitation">
          <AdminCard title="邀请成员" description="邀请加入当前租户，不会新建租户，也不会更改你现有的管理员身份。" action={<ConfigButton variant="ghost" onClick={() => setInviteOpen(false)}>收起</ConfigButton>}>
            <form onSubmit={createInvitation} className="admin-stack">
              <div className="admin-form-row">
                <label className="admin-field">受邀邮箱<input aria-label="受邀邮箱" ref={inviteEmailRef} type="email" autoComplete="off" placeholder="使用另一个测试邮箱" value={invite.email} onChange={(event) => setInvite((value) => ({ ...value, email: event.target.value }))} required disabled={busy} /></label>
                <label className="admin-field">邀请角色<select aria-label="邀请角色" value={invite.role} onChange={(event) => setInvite((value) => ({ ...value, role: event.target.value as Role }))} disabled={busy}>{roleOptions(data.currentMembership.role === "owner")}</select></label>
                <ConfigButton type="submit" variant="primary" disabled={busy}>生成邀请链接</ConfigButton>
              </div>
              <p className="admin-help">{invite.role === "member" ? "Member 进入凡小忆陪伴对话，不显示管理工作台。测试请使用与现有管理员不同的邮箱。" : "Admin / Owner 进入管理工作台；这不是用于查看陪伴界面的身份。"}</p>
            </form>
            {inviteLink && <div className="admin-invite-result">
              <strong>下一步：把链接交给 {invitedEmail}</strong>
              <p className="admin-help">邀请身份：{membershipLabels[invitedRole]}。系统只生成链接，不会自动发送邮件。</p>
              <div className="admin-copy-row">
                <input ref={inviteLinkRef} className="admin-control" aria-label="邀请链接" readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} />
                <ConfigButton onClick={() => void copyInvitation()}>复制邀请链接</ConfigButton>
              </div>
              <p className="admin-help">保留当前管理窗口，在无痕窗口打开链接，填写显示名称和密码并接受邀请。请勿公开分享此链接。</p>
            </div>}
          </AdminCard>
        </div>}

        <AdminCard title="成员与权限" description="权限仅属于当前租户。Owner 可管理所有角色，Admin 可管理 Admin / Member。" action={<input className="admin-control admin-search" type="search" aria-label="搜索成员" placeholder="搜索姓名或邮箱" value={search} onChange={(event) => setSearch(event.target.value)} />}>
          {filteredMembers.length === 0 ? <AdminEmpty title="没有匹配的成员">清除搜索条件，或使用页面上方的邀请入口添加成员。</AdminEmpty> : (
            <div className="admin-table-scroll" tabIndex={0} aria-label="成员列表，可横向滚动">
              <table className="admin-table" aria-label="租户成员">
                <thead><tr><th scope="col">成员</th><th scope="col">当前租户角色</th><th scope="col">首页界面</th><th scope="col">状态</th></tr></thead>
                <tbody>{filteredMembers.map((member) => <tr key={member.membershipId}>
                  <td><div className="admin-person"><span className="admin-avatar" aria-hidden="true">{member.displayName.slice(0, 1) || "U"}</span><div><strong>{member.displayName}{member.membershipId === data.currentMembership.id ? "（你）" : ""}</strong><small>{member.email}</small></div></div></td>
                  <td>{data.canManage ? <select className="admin-control" aria-label={`${member.displayName}的角色`} value={member.role} disabled={busy || (data.currentMembership.role !== "owner" && member.role === "owner")} onChange={(event) => updateRole(member.membershipId, event.target.value as Role)}>{roleOptions(data.currentMembership.role === "owner" || member.role === "owner")}</select> : membershipLabels[member.role]}</td>
                  <td><AdminBadge tone={member.role === "member" ? "info" : "neutral"}>{member.role === "member" ? "陪伴对话" : "管理工作台"}</AdminBadge></td>
                  <td><AdminBadge tone={member.status === "active" ? "success" : "neutral"}>{member.status === "active" ? "正常" : member.status === "suspended" ? "已停用" : member.status}</AdminBadge></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </AdminCard>

        {data.canManage && <AdminCard title="待接受邀请" action={<AdminBadge>{data.invitations.length} 个待接受</AdminBadge>}>
          {data.invitations.length === 0 ? <p className="admin-help">暂无待接受邀请。生成链接后，尚未接受的邀请会显示在这里。</p> : data.invitations.map((item) => <div key={item.id} className="admin-row">
            <div><strong>{item.email}</strong><p className="admin-help">{membershipLabels[item.role]} · 到期时间 {adminDate(item.expiresAt)}</p></div>
            <ConfigButton variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`撤销发给 ${item.email} 的邀请？原链接将无法使用。`)) void revokeInvitation(item.id); }}>撤销邀请</ConfigButton>
          </div>)}
        </AdminCard>}

        {data.canManage && onOpenQuality && <aside className="admin-guide">
          <div className="admin-guide-copy"><strong>要配置凡小忆的回应方式？</strong><p>行为文档、评测和版本发布统一在「陪伴质量治理」中管理。</p></div>
          <ConfigButton onClick={onOpenQuality}>前往陪伴质量治理 →</ConfigButton>
        </aside>}

        <details className="admin-details">
          <summary>租户管理 · 切换或新建租户</summary>
          <div className="admin-details-body">
            <p className="admin-help">下面显示的是租户名称，不是成员角色。新建租户会让你成为该租户的 Owner，不会创建 Member 账号。</p>
            <div className="admin-tenant-grid">{data.organizations.map((item) => <button type="button" className="admin-tenant-choice" key={item.tenantId} aria-current={item.tenantId === data.tenant.id ? "true" : undefined} disabled={busy || item.tenantId === data.tenant.id || item.status !== "active"} onClick={() => void switchTenant(item.tenantId)}>
              <strong>{item.tenantName}{item.tenantId === data.tenant.id ? " · 当前租户" : ""}</strong><span>你在此租户的身份：{membershipLabels[item.role]}</span>
            </button>)}</div>
            <form onSubmit={createTenant} className="admin-form-row">
              <label className="admin-field">新租户名称<input value={tenantDraft.tenantName} onChange={(event) => setTenantDraft((value) => ({ ...value, tenantName: event.target.value }))} required disabled={busy} /></label>
              <label className="admin-field">租户标识<input placeholder="例如 companion-test" pattern="[a-z0-9][a-z0-9-]*" value={tenantDraft.tenantSlug} onChange={(event) => setTenantDraft((value) => ({ ...value, tenantSlug: event.target.value }))} required disabled={busy} /></label>
              <ConfigButton type="submit" disabled={busy}>新建租户并切换</ConfigButton>
            </form>
          </div>
        </details>

        <details open className="admin-details" onToggle={(event) => { if (event.currentTarget.open) void refreshSkills(); }}>
          <summary>成员技能 · 高级设置</summary>
          <div className="admin-details-body">
            <p className="admin-help">声明式 Skill 上传后仅对你启用；含脚本的版本需提交审核，脚本只在 Docker 沙盒内执行。这里不是凡小忆的行为配置。</p>
            {skillsError && <><AdminFeedback error={skillsError} /><ConfigButton onClick={() => void loadSkills()}>重新加载技能</ConfigButton></>}
            {!skillsError && <ConfigButton disabled={busy} onClick={() => void refreshSkills()}>刷新技能列表</ConfigButton>}
            <form onSubmit={(event) => { event.stopPropagation(); uploadSkill(event); }} className="admin-skill-upload">
              <label className="admin-field admin-skill-file" htmlFor="tenant-skill-file">
                Skill ZIP 文件
                <span className="admin-file-picker"><span>选择 ZIP 文件</span><span>{skillFile?.name ?? "未选择文件"}</span></span>
                <input
                  id="tenant-skill-file"
                  ref={skillFileInputRef}
                  className="admin-file-input"
                  type="file"
                  accept=".zip,application/zip"
                  disabled={busy}
                  onChange={(event) => setSkillFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <ConfigButton type="submit" onClick={(event) => event.stopPropagation()} disabled={busy || !skillFile}>上传 ZIP 草稿</ConfigButton>
            </form>
            {skillsLoaded && skills.length === 0 && <p className="admin-help">暂无租户 Skill。</p>}
            {skills.map((skill) => <div key={skill.id} className="admin-row">
              <div><strong>{skill.name} · v{skill.version}</strong><p className="admin-help">{skill.status}{skill.buildStatus ? ` · 运行时 ${skill.buildStatus}` : ""}{skill.runtimeProfile ? ` · ${skill.runtimeProfile}` : ""}</p>{(skill.imageDigest || skill.lockfileDigest) && <p className="admin-help">image {digestPreview(skill.imageDigest)} · lock {digestPreview(skill.lockfileDigest)}</p>}{skill.buildError && <p className="admin-help">{skill.buildError}</p>}</div>
              <div className="admin-actions">
                {skill.status === "draft" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, "submit")}>提交审核</ConfigButton>}
                {data.canManage && skill.status === "pending_review" && skill.buildStatus !== "ready" && skill.buildStatus !== "building" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, skill.buildStatus === "failed" ? "retry" : "build")}>构建运行时</ConfigButton>}
                {data.canManage && skill.status === "pending_review" && <ConfigButton disabled={busy || (skill.buildStatus !== undefined && skill.buildStatus !== "ready")} title={skill.buildStatus === "failed" ? (skill.buildError ?? "运行时构建失败") : skill.buildStatus !== "ready" ? "运行时构建完成后才能发布" : undefined} onClick={() => void changeSkillStatus(skill.id, "publish")}>发布</ConfigButton>}
                {data.canManage && skill.status === "published" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, "suspend")}>停用</ConfigButton>}
                {data.canManage && skill.status === "suspended" && <>
                  {skill.buildStatus !== "ready" && skill.buildStatus !== "building" && <ConfigButton disabled={busy} onClick={() => void changeSkillStatus(skill.id, skill.buildStatus === "failed" ? "retry" : "build")}>构建运行时</ConfigButton>}
                  <ConfigButton disabled={busy || (skill.buildStatus !== undefined && skill.buildStatus !== "ready")} title={skill.buildStatus !== "ready" ? "运行时构建完成后才能恢复" : undefined} onClick={() => void changeSkillStatus(skill.id, "resume")}>恢复</ConfigButton>
                </>}
                <ConfigButton variant="ghost" disabled={busy} onClick={() => deleteSkill(skill)}>删除</ConfigButton>
              </div>
            </div>)}
          </div>
        </details>
      </div>
    </div>
  );
}
