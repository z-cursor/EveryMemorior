"use client";

import { useEffect, useRef, useState } from "react";
import type { SettingsSection } from "@/lib/settings-navigation";

type Account = {
  user: { email: string; displayName: string };
  tenant: { id: string; name: string };
  membership: { role: string };
  hostAccess?: boolean;
};

export function AccountMenu({
  projectOpen,
  onOpenSettings,
}: {
  projectOpen: boolean;
  onOpenSettings: (section: SettingsSection) => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) menuRef.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuRef.current?.open) {
        menuRef.current.open = false;
        menuRef.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    void fetch("/api/web-auth")
      .then((response) => response.ok ? response.json() : null)
      .then((data: { account?: Account | null } | null) => {
        const current = data?.account ?? null;
        setAccount(current);
        if (current?.tenant.id) {
          try {
            localStorage.setItem("pi-web:last-login-organization", JSON.stringify({ id: current.tenant.id, name: current.tenant.name }));
          } catch { /* Browser storage is optional. */ }
        }
      })
      .catch(() => undefined);
  }, []);

  const logout = async () => {
    await fetch("/api/web-auth", { method: "DELETE" });
    window.location.replace("/login");
  };
  const openSettings = (section: SettingsSection) => {
    if (menuRef.current) menuRef.current.open = false;
    onOpenSettings(section);
  };

  const initial = account?.user.displayName.trim().slice(0, 1).toLocaleUpperCase() || "U";
  return (
    <details ref={menuRef} className="account-menu">
      <summary>
        <span className="account-avatar">{initial}</span>
        <span className="account-copy">
          <strong>{account?.user.displayName || "User"}</strong>
          <small>{account?.tenant.name || "Pi Web"}</small>
        </span>
      </summary>
      <div className="account-popover">
        <header><strong>{account?.user.displayName}</strong><small>{account?.user.email}</small><span>{account?.tenant.name} · {account?.membership.role}</span></header>
        <button type="button" onClick={() => openSettings("general")}>常规设置</button>
        {account?.hostAccess && <button type="button" disabled={!projectOpen} onClick={() => openSettings("skills")}>Skill 管理</button>}
        <button type="button" onClick={() => openSettings("tenant")}>团队与用户隔离</button>
        <hr />
        <button type="button" onClick={() => void logout()}>退出登录</button>
      </div>
    </details>
  );
}
