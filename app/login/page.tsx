"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { I18nProvider, useI18n } from "@/hooks/useI18n";

type LoginOrganization = { tenantId: string; tenantName: string; tenantSlug?: string; role: string };
const LAST_ORGANIZATION_KEY = "pi-web:last-login-organization";

function safeDestination(): string {
  const destination = new URLSearchParams(window.location.search).get("next");
  return destination?.startsWith("/") && !destination.startsWith("//") ? destination : "/";
}

function LoginForm() {
  const { t } = useI18n();
  const [inviteToken, setInviteToken] = useState("");
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const [fields, setFields] = useState({
    tenantName: "",
    tenantSlug: "",
    displayName: "",
    email: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [organizations, setOrganizations] = useState<LoginOrganization[]>([]);
  const [tenantId, setTenantId] = useState("");
  const [lastOrganization, setLastOrganization] = useState<{ id: string; name: string } | null>(null);
  const [loadingOrganizations, setLoadingOrganizations] = useState(false);
  const [organizationNotice, setOrganizationNotice] = useState("");
  const organizationRequestRef = useRef(0);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LAST_ORGANIZATION_KEY) ?? "null") as { id?: unknown; name?: unknown } | null;
      if (typeof saved?.id === "string" && typeof saved.name === "string") {
        setLastOrganization({ id: saved.id, name: saved.name });
        setTenantId(saved.id);
      }
    } catch { /* Browser storage is optional. */ }
    setInviteToken(new URLSearchParams(window.location.search).get("invite") ?? "");
    void fetch("/api/web-auth")
      .then(async (response) => {
        const data = await response.json() as { setupRequired?: boolean };
        if (!response.ok) throw new Error();
        setSetupRequired(data.setupRequired === true);
      })
      .catch(() => setError(t("auth.loginFailed")));
  }, [t]);

  const update = (name: keyof typeof fields, value: string) => {
    setFields((current) => ({ ...current, [name]: value }));
    if (name === "email" || name === "password") {
      organizationRequestRef.current += 1;
      setOrganizations([]);
      setLoadingOrganizations(false);
      setTenantId(lastOrganization?.id ?? "");
      setOrganizationNotice("");
    }
  };

  const loadOrganizations = async (): Promise<LoginOrganization[] | null> => {
    if (inviteToken || setupRequired || !fields.email || !fields.password) return null;
    const requestId = ++organizationRequestRef.current;
    setLoadingOrganizations(true);
    setError("");
    setOrganizationNotice("");
    try {
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "login-options", email: fields.email, password: fields.password }),
      });
      const data = await response.json() as { error?: string; organizations?: LoginOrganization[] };
      if (requestId !== organizationRequestRef.current) return null;
      if (!response.ok || !data.organizations?.length) {
        setError(data.error || t("auth.loginFailed"));
        return null;
      }
      setOrganizations(data.organizations);
      setTenantId((current) => data.organizations!.some((item) => item.tenantId === current)
        ? current
        : data.organizations!.some((item) => item.tenantId === lastOrganization?.id)
          ? lastOrganization!.id
          : data.organizations!.length === 1 ? data.organizations![0].tenantId : "");
      return data.organizations;
    } catch {
      if (requestId === organizationRequestRef.current) setError(t("auth.loginFailed"));
      return null;
    } finally {
      if (requestId === organizationRequestRef.current) setLoadingOrganizations(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setOrganizationNotice("");
    try {
      let selectedTenantId = "";
      if (!inviteToken && !setupRequired) {
        const options = organizations.length ? organizations : await loadOrganizations();
        if (!options) return;
        selectedTenantId = options.some((item) => item.tenantId === tenantId)
          ? tenantId
          : options.some((item) => item.tenantId === lastOrganization?.id)
            ? lastOrganization!.id
            : options.length === 1 ? options[0].tenantId : "";
        if (!selectedTenantId) {
          setOrganizationNotice("请选择要登录的组织，然后点击登录。");
          return;
        }
      }
      const response = await fetch("/api/web-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: inviteToken ? "accept-invitation" : setupRequired ? "setup" : "login",
          token: inviteToken,
          tenantId: selectedTenantId || undefined,
          ...fields,
        }),
      });
      const data = await response.json() as { error?: string; account?: { tenant?: { id?: string; name?: string } } };
      if (!response.ok) {
        setError(data.error || t("auth.loginFailed"));
        return;
      }
      if (data.account?.tenant?.id && data.account.tenant.name) {
        const selected = { id: data.account.tenant.id, name: data.account.tenant.name };
        setLastOrganization(selected);
        try { localStorage.setItem(LAST_ORGANIZATION_KEY, JSON.stringify(selected)); } catch { /* Browser storage is optional. */ }
      }
      window.location.replace(safeDestination());
    } catch {
      setError(t("auth.loginFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="tenant-login-page">
      <section className="tenant-login-panel">
        <form className="tenant-login-form" onSubmit={submit}>
          <div className="tenant-login-brand" aria-label="EveryMemorior">EM</div>
          <span className="tenant-login-eyebrow">{inviteToken ? "Organization invitation" : setupRequired ? t("auth.firstSetup") : t("auth.secureLogin")}</span>
          <h2>{inviteToken ? "接受组织邀请" : setupRequired ? t("auth.createWorkspace") : t("auth.logIn")}</h2>
          <p>{inviteToken ? "设置显示名称和密码，接受后将直接进入受邀组织。已有账号也可使用当前密码。" : setupRequired ? t("auth.setupDescription") : t("auth.prompt")}</p>

          {(setupRequired || inviteToken) && (
            <>
              {setupRequired && <label>{t("auth.tenantName")}<input value={fields.tenantName} onChange={(e) => update("tenantName", e.target.value)} required autoFocus /></label>}
              {setupRequired && <label>{t("auth.tenantSlug")}<input value={fields.tenantSlug} onChange={(e) => update("tenantSlug", e.target.value)} pattern="[a-z0-9][a-z0-9-]*" required /></label>}
              <label>{t("auth.displayName")}<input value={fields.displayName} onChange={(e) => update("displayName", e.target.value)} required /></label>
            </>
          )}
          {!inviteToken && <label>{t("auth.email")}<input type="email" value={fields.email} onChange={(e) => update("email", e.target.value)} autoComplete="username" autoFocus={!setupRequired} required /></label>}
          <label>{t("auth.password")}<input type="password" value={fields.password} onChange={(e) => update("password", e.target.value)} onBlur={(event) => { if (event.relatedTarget instanceof HTMLButtonElement && event.relatedTarget.type === "submit") return; if (!inviteToken && setupRequired === false && fields.email && fields.password && !organizations.length && !loadingOrganizations) void loadOrganizations(); }} autoComplete={setupRequired || inviteToken ? "new-password" : "current-password"} minLength={8} required /></label>
          {!inviteToken && setupRequired === false && (
            <div className="tenant-login-organization">
              <label>组织<select value={tenantId} onChange={(event) => { setTenantId(event.target.value); setOrganizationNotice(""); }} disabled={!organizations.length || loadingOrganizations} required={organizations.length > 1}>
                {!organizations.length && <option value={lastOrganization?.id ?? ""}>{loadingOrganizations ? "正在识别组织…" : lastOrganization?.name ?? "填写账号后自动显示"}</option>}
                {organizations.length > 1 && <option value="">请选择组织</option>}
                {organizations.map((item) => <option key={item.tenantId} value={item.tenantId}>{item.tenantName} · {item.role}</option>)}
              </select></label>
            </div>
          )}
          <button type="submit" disabled={busy || setupRequired === null}>
            {busy ? t("auth.loggingIn") : inviteToken ? "接受邀请" : setupRequired ? t("auth.finishSetup") : t("auth.logIn")}
          </button>
          <p className={error ? "web-login-error" : "tenant-login-hint"} role={error ? "alert" : undefined} aria-live="polite">{error || organizationNotice}</p>
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return <I18nProvider><LoginForm /></I18nProvider>;
}
