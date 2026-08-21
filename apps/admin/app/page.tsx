"use client";

import type {
  ConnectorManifest,
  FeatureFlag,
  ProductionRelease,
  SupportAccessGrant,
} from "@localclear/domain";
import { ReleaseEvidenceSchema } from "@localclear/domain";
import type { Session } from "@supabase/supabase-js";
import { useCallback, useEffect, useState } from "react";
import {
  operationsApi,
  type ConnectorUpdate,
  type FeatureFlagUpdate,
  type OperationsDashboard,
  type SupportSession,
} from "../lib/api";
import { supabase } from "../lib/supabase";

export default function OperationsPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [dashboard, setDashboard] = useState<OperationsDashboard | null>(null);
  const [supportGrants, setSupportGrants] = useState<SupportAccessGrant[]>([]);
  const [supportSession, setSupportSession] = useState<SupportSession | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [emailSent, setEmailSent] = useState(false);

  const load = useCallback(async (current: Session) => {
    setError(null);
    try {
      const [nextDashboard, grants] = await Promise.all([
        operationsApi.dashboard(current.access_token),
        operationsApi.activeSupportGrants(current.access_token),
      ]);
      setDashboard(nextDashboard);
      setSupportGrants(grants.grants);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dashboard failed");
    }
  }, []);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoadingAuth(false);
      if (data.session) void load(data.session);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next) void load(next);
      else {
        setDashboard(null);
        setSupportGrants([]);
        setSupportSession(null);
      }
    });
    return () => data.subscription.unsubscribe();
  }, [load]);

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => void load(session), 30_000);
    return () => window.clearInterval(timer);
  }, [load, session]);

  if (loadingAuth) {
    return <main className="center">Checking operator session…</main>;
  }

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card" aria-labelledby="sign-in-title">
          <p className="eyebrow">Restricted operations surface</p>
          <h1 id="sign-in-title">LocalClear Operations</h1>
          <p>
            Sign in with an administrator or operator account. Access is checked
            again by the API for every request.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              void supabase.auth
                .signInWithOtp({
                  email,
                  options: { emailRedirectTo: window.location.origin },
                })
                .then(({ error: authError }) => {
                  if (authError) throw authError;
                  setEmailSent(true);
                })
                .catch((caught: unknown) =>
                  setError(
                    caught instanceof Error
                      ? caught.message
                      : "Sign-in link could not be sent",
                  ),
                );
            }}
          >
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <button type="submit">Send secure sign-in link</button>
          </form>
          {emailSent ? (
            <p role="status" className="success">
              Check your email for the sign-in link.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="error">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  const roles = Array.isArray(session.user.app_metadata.roles)
    ? session.user.app_metadata.roles.filter(
        (role: unknown): role is string => typeof role === "string",
      )
    : [];
  const isAdmin = roles.includes("admin");

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Last 24 hours</p>
          <h1>Connector operations</h1>
          <p className="muted">
            Health, policy gates, and audited remote controls
          </p>
        </div>
        <div className="header-actions">
          <span className="role">{isAdmin ? "Administrator" : "Operator"}</span>
          <button className="secondary" onClick={() => void load(session)}>
            Refresh
          </button>
          <button
            className="quiet"
            onClick={() => void supabase.auth.signOut()}
          >
            Sign out
          </button>
        </div>
      </header>

      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}
      {!roles.some((role) => role === "admin" || role === "operator") ? (
        <div className="banner error" role="alert">
          This account does not have an operations role.
        </div>
      ) : null}

      {dashboard ? (
        <>
          <section aria-labelledby="summary-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Live guardrails</p>
                <h2 id="summary-title">Operational summary</h2>
              </div>
              <p className="muted">
                Generated {new Date(dashboard.generatedAt).toLocaleString()}
              </p>
            </div>
            <div className="metrics">
              <Metric
                value={
                  dashboard.connectors.filter((item) => item.enabled).length
                }
                label="enabled connectors"
              />
              <Metric value={dashboard.alerts.length} label="active alerts" />
              <Metric
                value={dashboard.duplicateBlocks}
                label="duplicate blocks"
              />
              <Metric
                value={dashboard.health.reduce(
                  (sum, metric) => sum + metric.active,
                  0,
                )}
                label="active jobs"
              />
            </div>
          </section>

          <section aria-labelledby="alerts-title">
            <h2 id="alerts-title">Alerts</h2>
            {dashboard.alerts.length === 0 ? (
              <div className="empty">
                No alert thresholds are currently crossed.
              </div>
            ) : (
              <div className="alert-grid">
                {dashboard.alerts.map((alert) => (
                  <article
                    className={`alert ${alert.severity}`}
                    key={`${alert.code}-${alert.platform ?? "global"}`}
                  >
                    <strong>{alert.code.replaceAll("_", " ")}</strong>
                    <span>{alert.message}</span>
                    {alert.platform ? <small>{alert.platform}</small> : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="health-title">
            <h2 id="health-title">Connector health</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Platform</th>
                    <th>Connector</th>
                    <th>App</th>
                    <th>Total</th>
                    <th>Published</th>
                    <th>Paused</th>
                    <th>Failed</th>
                    <th>Success</th>
                    <th>Failure types</th>
                  </tr>
                </thead>
                <tbody>
                  {dashboard.health.length === 0 ? (
                    <tr>
                      <td colSpan={9}>No publishing jobs in this window.</td>
                    </tr>
                  ) : (
                    dashboard.health.map((metric) => (
                      <tr
                        key={`${metric.platform}-${metric.connectorVersion}-${metric.appVersion}`}
                      >
                        <th scope="row">{metric.platform}</th>
                        <td>{metric.connectorVersion}</td>
                        <td>{metric.appVersion}</td>
                        <td>{metric.total}</td>
                        <td>{metric.published}</td>
                        <td>{metric.paused}</td>
                        <td>{metric.failed}</td>
                        <td>
                          {metric.successRate === null
                            ? "—"
                            : `${Math.round(metric.successRate * 100)}%`}
                        </td>
                        <td>
                          {Object.entries(metric.failureTypes)
                            .map(([code, count]) => `${code}: ${count}`)
                            .join(", ") || "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="connectors-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Governed configuration</p>
                <h2 id="connectors-title">Connector controls</h2>
              </div>
              {!isAdmin ? (
                <p className="muted">Read-only for operator accounts</p>
              ) : null}
            </div>
            <div className="connector-grid">
              {dashboard.connectors.map((connector) => (
                <ConnectorControl
                  key={`${connector.id}-${connector.definitionVersion}`}
                  connector={connector}
                  accessToken={session.access_token}
                  canEdit={isAdmin}
                  onUpdated={() => void load(session)}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="features-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Global release controls</p>
                <h2 id="features-title">Feature kill switches</h2>
              </div>
              {!isAdmin ? (
                <p className="muted">Read-only for operator accounts</p>
              ) : null}
            </div>
            <div className="connector-grid">
              {dashboard.featureFlags.map((flag) => (
                <FeatureFlagControl
                  key={`${flag.key}-${flag.version}`}
                  flag={flag}
                  accessToken={session.access_token}
                  canEdit={isAdmin}
                  onUpdated={() => void load(session)}
                />
              ))}
            </div>
          </section>

          <section aria-labelledby="releases-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Two-person control</p>
                <h2 id="releases-title">Production releases</h2>
              </div>
              <p className="muted">
                Evidence is immutable within a submitted review cycle.
              </p>
            </div>
            {isAdmin ? (
              <CreateReleaseControl
                connectors={dashboard.connectors}
                accessToken={session.access_token}
                onUpdated={() => void load(session)}
              />
            ) : null}
            {dashboard.releases.length === 0 ? (
              <div className="empty">No governed release records yet.</div>
            ) : (
              <div className="connector-grid release-grid">
                {dashboard.releases.map((release) => (
                  <ReleaseControl
                    key={`${release.id}-${release.updatedAt}`}
                    release={release}
                    accessToken={session.access_token}
                    canEdit={isAdmin}
                    onUpdated={() => void load(session)}
                  />
                ))}
              </div>
            )}
          </section>

          <section aria-labelledby="support-title">
            <div className="section-heading">
              <div>
                <p className="eyebrow">No standing access</p>
                <h2 id="support-title">My active support grants</h2>
              </div>
              <p className="muted">
                Only grants assigned to this account appear.
              </p>
            </div>
            {supportGrants.length === 0 ? (
              <div className="empty">No user-authorized support sessions.</div>
            ) : (
              <div className="connector-grid">
                {supportGrants.map((grant) => (
                  <article className="connector-card" key={grant.id}>
                    <h3>{grant.reasonCode.replaceAll("_", " ")}</h3>
                    <p>Expires {new Date(grant.expiresAt).toLocaleString()}</p>
                    <p>{grant.scope.join(" · ")}</p>
                    <button
                      onClick={() => {
                        setError(null);
                        void operationsApi
                          .supportSession(session.access_token, grant.id)
                          .then(setSupportSession)
                          .catch((caught: unknown) =>
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : "Support session failed",
                            ),
                          );
                      }}
                    >
                      Open redacted session
                    </button>
                  </article>
                ))}
              </div>
            )}
            {supportSession ? (
              <article className="support-session">
                <div className="section-heading">
                  <h3>Consented session</h3>
                  <button
                    className="quiet"
                    onClick={() => setSupportSession(null)}
                  >
                    Close
                  </button>
                </div>
                <p className="muted">
                  Credentials, exact locations, and buyer message bodies are
                  never included.
                </p>
                <h4>Device health ({supportSession.devices.length})</h4>
                <pre>{JSON.stringify(supportSession.devices, null, 2)}</pre>
                <h4>Job metadata ({supportSession.jobs.length})</h4>
                <pre>{JSON.stringify(supportSession.jobs, null, 2)}</pre>
                <h4>
                  User-redacted diagnostics ({supportSession.diagnostics.length}
                  )
                </h4>
                <div className="diagnostic-grid">
                  {supportSession.diagnostics.map((artifact) => (
                    <figure key={artifact.id}>
                      {artifact.readUrl ? (
                        // This URL expires after 60 seconds and exists only for
                        // the active, assigned support grant.
                        <img
                          src={artifact.readUrl}
                          alt="User-consented redacted diagnostic"
                        />
                      ) : (
                        <div className="empty">
                          Preview provider unavailable
                        </div>
                      )}
                      <figcaption>
                        {artifact.kind.replaceAll("_", " ")}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </article>
            ) : null}
          </section>
        </>
      ) : (
        <div className="center">Loading operations data…</div>
      )}
    </main>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <article className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </article>
  );
}

function CreateReleaseControl({
  connectors,
  accessToken,
  onUpdated,
}: {
  connectors: ConnectorManifest[];
  accessToken: string;
  onUpdated(): void;
}) {
  const [version, setVersion] = useState("");
  const [target, setTarget] =
    useState<ProductionRelease["target"]>("public_beta");
  const [summary, setSummary] = useState("");
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const [evidenceJson, setEvidenceJson] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <details className="release-create">
      <summary>Create governed release draft</summary>
      <div className="form-grid">
        <label>
          Semantic version
          <input
            placeholder="v1.0.0"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          />
        </label>
        <label>
          Release target
          <select
            value={target}
            onChange={(event) =>
              setTarget(event.target.value as ProductionRelease["target"])
            }
          >
            <option value="public_beta">public beta</option>
            <option value="v1_public">v1 public</option>
          </select>
        </label>
        <label>
          Release summary
          <textarea
            value={summary}
            onChange={(event) => setSummary(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>Production connectors</legend>
          {connectors.map((connector) => (
            <label className="toggle" key={connector.id}>
              <input
                type="checkbox"
                checked={connectorIds.includes(connector.id)}
                onChange={(event) =>
                  setConnectorIds((current) =>
                    event.target.checked
                      ? [...current, connector.id]
                      : current.filter((id) => id !== connector.id),
                  )
                }
              />
              {connector.platform} · {connector.policyStatus}
            </label>
          ))}
        </fieldset>
        <label>
          Evidence manifest JSON
          <textarea
            className="evidence-input"
            spellCheck={false}
            value={evidenceJson}
            onChange={(event) => setEvidenceJson(event.target.value)}
          />
        </label>
        <p className="muted">
          Supply each required policy, scan, SBOM, architecture review, and
          independent penetration-test receipt with URL, SHA-256, and review
          time. The API revalidates the complete gate on submission.
        </p>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          disabled={
            busy ||
            !version.trim() ||
            !summary.trim() ||
            connectorIds.length < 2
          }
          onClick={() => {
            setBusy(true);
            setError(null);
            try {
              const evidence = ReleaseEvidenceSchema.array().parse(
                JSON.parse(evidenceJson),
              );
              void operationsApi
                .createRelease(accessToken, {
                  version,
                  target,
                  summary,
                  connectorIds,
                  evidence,
                })
                .then(() => {
                  setVersion("");
                  setSummary("");
                  setConnectorIds([]);
                  setEvidenceJson("[]");
                  onUpdated();
                })
                .catch((caught: unknown) =>
                  setError(
                    caught instanceof Error ? caught.message : "Create failed",
                  ),
                )
                .finally(() => setBusy(false));
            } catch (caught) {
              setBusy(false);
              setError(
                caught instanceof Error
                  ? caught.message
                  : "Evidence JSON is invalid",
              );
            }
          }}
        >
          {busy ? "Creating…" : "Create audited draft"}
        </button>
      </div>
    </details>
  );
}

function ReleaseControl({
  release,
  accessToken,
  canEdit,
  onUpdated,
}: {
  release: ProductionRelease;
  accessToken: string;
  canEdit: boolean;
  onUpdated(): void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (
    action: "submit" | "approve" | "reject" | "deploy" | "rollback",
  ) => {
    setBusy(true);
    setError(null);
    const operation =
      action === "submit"
        ? operationsApi.submitRelease(accessToken, release.id)
        : operationsApi.reviewRelease(
            accessToken,
            release.id,
            action,
            action === "reject" ? reason : undefined,
          );
    void operation
      .then(onUpdated)
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : "Review failed"),
      )
      .finally(() => setBusy(false));
  };

  return (
    <article className="connector-card">
      <div className="connector-title">
        <div>
          <h3>{release.version}</h3>
          <p>{release.target.replaceAll("_", " ")}</p>
        </div>
        <span
          className={`pill ${release.status === "deployed" ? "enabled" : "disabled"}`}
        >
          {release.status.replaceAll("_", " ")}
        </span>
      </div>
      <p>{release.summary}</p>
      <p>
        {release.connectorIds.length} connectors · {release.evidence.length}
        evidence receipts · {release.approvalActorIds.length}/2 approvals
      </p>
      {release.rejectionReason ? (
        <p className="error">{release.rejectionReason}</p>
      ) : null}
      {canEdit ? (
        <div className="release-actions">
          {release.status === "draft" || release.status === "rejected" ? (
            <button disabled={busy} onClick={() => run("submit")}>
              Submit evidence gate
            </button>
          ) : null}
          {release.status === "pending_approval" ? (
            <>
              <button disabled={busy} onClick={() => run("approve")}>
                Record my approval
              </button>
              <label>
                Rejection reason
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
              <button
                className="secondary danger-button"
                disabled={busy || !reason.trim()}
                onClick={() => run("reject")}
              >
                Reject
              </button>
            </>
          ) : null}
          {release.status === "approved" ? (
            <button disabled={busy} onClick={() => run("deploy")}>
              Record deployment
            </button>
          ) : null}
          {release.status === "deployed" ? (
            <button
              className="secondary danger-button"
              disabled={busy}
              onClick={() => run("rollback")}
            >
              Record rollback
            </button>
          ) : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function FeatureFlagControl({
  flag,
  accessToken,
  canEdit,
  onUpdated,
}: {
  flag: FeatureFlag;
  accessToken: string;
  canEdit: boolean;
  onUpdated(): void;
}) {
  const [form, setForm] = useState<FeatureFlagUpdate>({
    enabled: flag.enabled,
    killSwitchReason: flag.killSwitchReason,
    owner: flag.owner,
    changeSummary: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <article className="connector-card">
      <div className="connector-title">
        <div>
          <h3>{flag.key.replaceAll("_", " ")}</h3>
          <p>{flag.description}</p>
        </div>
        <span className={`pill ${flag.enabled ? "enabled" : "disabled"}`}>
          {flag.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <p>
        Owner: {flag.owner} · version {flag.version}
      </p>
      {flag.killSwitchReason ? (
        <p className="error">{flag.killSwitchReason}</p>
      ) : null}
      {canEdit ? (
        <details>
          <summary>Change audited flag</summary>
          <div className="form-grid">
            <label>
              Owner
              <input
                value={form.owner}
                onChange={(event) =>
                  setForm({ ...form, owner: event.target.value })
                }
              />
            </label>
            <label>
              Kill-switch reason
              <input
                value={form.killSwitchReason ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    killSwitchReason: event.target.value || null,
                  })
                }
              />
            </label>
            <label>
              Required change summary
              <textarea
                value={form.changeSummary}
                onChange={(event) =>
                  setForm({ ...form, changeSummary: event.target.value })
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({
                    ...form,
                    enabled: event.target.checked,
                    killSwitchReason: event.target.checked
                      ? null
                      : form.killSwitchReason,
                  })
                }
              />
              Feature enabled
            </label>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              disabled={busy || !form.changeSummary.trim()}
              onClick={() => {
                setBusy(true);
                setError(null);
                void operationsApi
                  .updateFeatureFlag(accessToken, flag.key, form)
                  .then(onUpdated)
                  .catch((caught: unknown) =>
                    setError(
                      caught instanceof Error
                        ? caught.message
                        : "Update failed",
                    ),
                  )
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Saving…" : "Save audited change"}
            </button>
          </div>
        </details>
      ) : null}
    </article>
  );
}

function ConnectorControl({
  connector,
  accessToken,
  canEdit,
  onUpdated,
}: {
  connector: ConnectorManifest;
  accessToken: string;
  canEdit: boolean;
  onUpdated(): void;
}) {
  const [form, setForm] = useState<ConnectorUpdate>({
    enabled: connector.enabled,
    killSwitchReason: connector.killSwitchReason,
    policyStatus: connector.policyStatus,
    productionMethod: connector.productionMethod,
    approvalEvidenceUrl: connector.approvalEvidenceUrl,
    owner: connector.owner,
    supportedAppVersions: connector.supportedAppVersions,
    canaryTestId: connector.canaryTestId,
    changeSummary: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await operationsApi.updateConnector(accessToken, connector.id, form);
      onUpdated();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="connector-card">
      <div className="connector-title">
        <div>
          <h3>{connector.platform}</h3>
          <p>
            {connector.kind} · v{connector.version} · definition{" "}
            {connector.definitionVersion}
          </p>
        </div>
        <span className={`pill ${connector.enabled ? "enabled" : "disabled"}`}>
          {connector.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <dl>
        <div>
          <dt>Policy</dt>
          <dd>{connector.policyStatus}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{connector.owner}</dd>
        </div>
        <div>
          <dt>Canary</dt>
          <dd>{connector.canaryTestId ?? "missing"}</dd>
        </div>
      </dl>
      {canEdit ? (
        <details>
          <summary>Change governed definition</summary>
          <div className="form-grid">
            <label>
              Policy status
              <select
                value={form.policyStatus}
                onChange={(event) =>
                  setForm({
                    ...form,
                    policyStatus: event.target
                      .value as ConnectorManifest["policyStatus"],
                  })
                }
              >
                <option value="approved">approved</option>
                <option value="review">review</option>
                <option value="internal_only">internal only</option>
                <option value="disabled">disabled</option>
              </select>
            </label>
            <label>
              Owner
              <input
                value={form.owner}
                onChange={(event) =>
                  setForm({ ...form, owner: event.target.value })
                }
              />
            </label>
            <label>
              Permitted production method
              <input
                value={form.productionMethod ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    productionMethod: event.target.value || null,
                  })
                }
              />
            </label>
            <label>
              Approval evidence URL
              <input
                type="url"
                value={form.approvalEvidenceUrl ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    approvalEvidenceUrl: event.target.value || null,
                  })
                }
              />
            </label>
            <label>
              Supported app versions (comma separated)
              <input
                value={form.supportedAppVersions.join(", ")}
                onChange={(event) =>
                  setForm({
                    ...form,
                    supportedAppVersions: event.target.value
                      .split(",")
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
              />
            </label>
            <label>
              Canary test ID
              <input
                value={form.canaryTestId ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    canaryTestId: event.target.value || null,
                  })
                }
              />
            </label>
            <label>
              Kill-switch reason
              <input
                value={form.killSwitchReason ?? ""}
                onChange={(event) =>
                  setForm({
                    ...form,
                    killSwitchReason: event.target.value || null,
                  })
                }
              />
            </label>
            <label>
              Required change summary
              <textarea
                required
                value={form.changeSummary}
                onChange={(event) =>
                  setForm({ ...form, changeSummary: event.target.value })
                }
              />
            </label>
            <label className="toggle">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({
                    ...form,
                    enabled: event.target.checked,
                    killSwitchReason: event.target.checked
                      ? null
                      : form.killSwitchReason,
                  })
                }
              />
              Connector enabled
            </label>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button
              onClick={() => void save()}
              disabled={busy || !form.changeSummary.trim()}
            >
              {busy ? "Saving…" : "Save audited change"}
            </button>
          </div>
        </details>
      ) : null}
    </article>
  );
}
