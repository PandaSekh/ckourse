import { useState, useEffect, useCallback } from "react";
import {
  HardDrivesIcon as HardDrives,
  PlusIcon as Plus,
  PencilSimpleIcon as PencilSimple,
  TrashIcon as Trash,
  PlugsConnectedIcon as PlugsConnected,
  WarningCircleIcon as WarningCircle,
  CheckCircleIcon as CheckCircle,
  SpinnerGapIcon as SpinnerGap,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import {
  getServers,
  saveServer,
  deleteServer,
  testServer,
  countServerCourses,
  defaultPort,
  SERVER_KIND_LABELS,
  type ServerConfig,
  type ServerInput,
  type ServerKind,
} from "@/lib/servers";
import { SectionCard, CredInput } from "./SettingsPrimitives";

const KINDS: ServerKind[] = ["sftp", "webdav", "s3"];

const KIND_HINTS: Record<ServerKind, string> = {
  sftp: "Any machine you can SSH into. Nothing to install on the server.",
  webdav: "Nextcloud, ownCloud, rclone serve webdav, Apache mod_dav.",
  s3: "MinIO, Backblaze B2, Cloudflare R2, Wasabi, AWS S3.",
};

/** Empty form state for a new server of the given kind. */
function blankForm(kind: ServerKind): ServerInput {
  return {
    name: "",
    kind,
    host: "",
    port: defaultPort(kind),
    username: "",
    basePath: kind === "s3" ? "/" : "/",
    bucket: "",
    region: "",
    pathStyle: true,
    password: "",
    privateKey: "",
    passphrase: "",
  };
}

/** Prefill the form from a saved server. Secrets stay blank — they're in the keychain. */
function formFrom(server: ServerConfig): ServerInput {
  return {
    id: server.id,
    name: server.name,
    kind: server.kind,
    host: server.host,
    port: server.port,
    username: server.username,
    basePath: server.basePath,
    bucket: server.bucket,
    region: server.region,
    pathStyle: server.pathStyle,
    password: "",
    privateKey: "",
    passphrase: "",
  };
}

export function ServersSection({ index }: { index: number }) {
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [form, setForm] = useState<ServerInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ server: ServerConfig; courses: number } | null>(
    null,
  );

  const refresh = useCallback(async () => {
    try {
      setServers(await getServers());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const set = <K extends keyof ServerInput>(key: K, value: ServerInput[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const startAdd = () => {
    setError(null);
    setNotice(null);
    setForm(blankForm("sftp"));
  };

  const startEdit = (server: ServerConfig) => {
    setError(null);
    setNotice(null);
    setForm(formFrom(server));
  };

  const closeForm = () => {
    setForm(null);
    setError(null);
    setNotice(null);
  };

  const handleSave = async () => {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      await saveServer(form);
      await refresh();
      closeForm();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    if (!form) return;
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      setNotice(await testServer(form));
    } catch (e) {
      setError(String(e));
    } finally {
      setTesting(false);
    }
  };

  // Removing a server breaks playback for its courses, so say how many first.
  const askDelete = async (server: ServerConfig) => {
    setError(null);
    try {
      setConfirmDelete({ server, courses: await countServerCourses(server.id) });
    } catch {
      setConfirmDelete({ server, courses: 0 });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setBusy(true);
    try {
      await deleteServer(confirmDelete.server.id);
      await refresh();
      setConfirmDelete(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      title="Servers"
      icon={<HardDrives className="size-4 text-info" weight="bold" />}
      index={index}
    >
      <p className="px-2 pb-2 font-sans text-xs text-muted-foreground">
        Stream courses straight from your own server. Passwords and keys are stored in
        your system keychain, never in the app's database.
      </p>

      {form ? (
        <ServerForm
          form={form}
          set={set}
          busy={busy}
          testing={testing}
          onSave={handleSave}
          onTest={handleTest}
          onCancel={closeForm}
        />
      ) : (
        <div className="flex flex-col gap-2 py-1">
          {servers.length === 0 && (
            <div className="rounded-lg bg-secondary/40 px-3 py-4 text-center">
              <p className="font-sans text-xs text-muted-foreground">
                No servers yet. Add one to import courses over SFTP, WebDAV or S3.
              </p>
            </div>
          )}

          {servers.map((server) => (
            <div
              key={server.id}
              className="flex items-center justify-between gap-4 rounded-lg bg-secondary/40 px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="truncate font-sans text-sm font-medium text-foreground">
                  {server.name}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {describe(server)}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => startEdit(server)}
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  aria-label={`Edit ${server.name}`}
                >
                  <PencilSimple className="size-4" />
                </button>
                <button
                  onClick={() => void askDelete(server)}
                  className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Remove ${server.name}`}
                >
                  <Trash className="size-4" />
                </button>
              </div>
            </div>
          ))}

          <button
            onClick={startAdd}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2.5",
              "font-sans text-sm font-medium text-muted-foreground",
              "transition-colors hover:border-primary/40 hover:text-foreground",
            )}
          >
            <Plus className="size-4" weight="bold" />
            Add a server
          </button>
        </div>
      )}

      {notice && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg bg-primary/10 px-3 py-2">
          <CheckCircle className="mt-px size-4 shrink-0 text-primary" weight="fill" />
          <p className="font-sans text-xs text-foreground">{notice}</p>
        </div>
      )}

      {error && (
        <div className="mx-2 mt-2 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2">
          <WarningCircle className="mt-px size-4 shrink-0 text-destructive" weight="fill" />
          <p className="whitespace-pre-wrap font-sans text-xs text-destructive">{error}</p>
        </div>
      )}

      {confirmDelete && (
        <div className="mx-2 mt-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
          <p className="font-sans text-xs text-foreground">
            Remove <span className="font-semibold">{confirmDelete.server.name}</span>?
            {confirmDelete.courses > 0 && (
              <>
                {" "}
                {confirmDelete.courses} imported{" "}
                {confirmDelete.courses === 1 ? "course" : "courses"} will stop playing —
                progress and notes are kept.
              </>
            )}
          </p>
          <div className="mt-2.5 flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(null)}
              className="rounded-lg px-3 py-1.5 font-sans text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              Cancel
            </button>
            <button
              onClick={() => void handleDelete()}
              disabled={busy}
              className="rounded-lg bg-destructive px-3 py-1.5 font-sans text-sm font-semibold text-background transition-colors hover:bg-destructive/90 disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

/** One-line summary of where a server points. */
function describe(server: ServerConfig): string {
  switch (server.kind) {
    case "sftp":
      return `sftp://${server.username}@${server.host}:${server.port}${server.basePath}`;
    case "webdav":
      return `${server.host}${server.basePath === "/" ? "" : server.basePath}`;
    case "s3":
      return `s3://${server.bucket}${server.basePath === "/" ? "" : server.basePath}`;
  }
}

interface ServerFormProps {
  form: ServerInput;
  set: <K extends keyof ServerInput>(key: K, value: ServerInput[K]) => void;
  busy: boolean;
  testing: boolean;
  onSave: () => void;
  onTest: () => void;
  onCancel: () => void;
}

function ServerForm({ form, set, busy, testing, onSave, onTest, onCancel }: ServerFormProps) {
  const isEdit = Boolean(form.id);
  const [useKey, setUseKey] = useState(false);

  return (
    <div className="flex flex-col gap-3 py-1">
      <div className="px-2">
        <span className="mb-1.5 block font-sans text-xs font-medium text-muted-foreground">
          Type
        </span>
        <div className="flex gap-1.5">
          {KINDS.map((kind) => (
            <button
              key={kind}
              onClick={() => {
                set("kind", kind);
                set("port", defaultPort(kind));
              }}
              className={cn(
                "flex-1 rounded-lg border px-3 py-2 font-sans text-xs font-medium transition-colors",
                form.kind === kind
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {SERVER_KIND_LABELS[kind]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 font-sans text-[11px] text-muted-foreground">
          {KIND_HINTS[form.kind]}
        </p>
      </div>

      <CredInput
        label="Name"
        value={form.name}
        onChange={(v) => set("name", v)}
        placeholder="Home server"
      />

      {form.kind === "sftp" && (
        <>
          <div className="flex gap-2">
            <div className="flex-1">
              <CredInput
                label="Host"
                value={form.host}
                onChange={(v) => set("host", v)}
                placeholder="192.168.1.10 or vps.example.com"
              />
            </div>
            <div className="w-24">
              <CredInput
                label="Port"
                value={String(form.port ?? 22)}
                onChange={(v) => set("port", Number(v) || 22)}
                placeholder="22"
              />
            </div>
          </div>
          <CredInput
            label="Username"
            value={form.username}
            onChange={(v) => set("username", v)}
            placeholder="ubuntu"
          />

          <div className="px-2">
            <div className="flex gap-1.5">
              <button
                onClick={() => setUseKey(false)}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-1.5 font-sans text-xs transition-colors",
                  !useKey
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Password
              </button>
              <button
                onClick={() => setUseKey(true)}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-1.5 font-sans text-xs transition-colors",
                  useKey
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                Private key
              </button>
            </div>
          </div>

          {useKey ? (
            <>
              <label className="block px-2">
                <span className="mb-1 block font-sans text-xs font-medium text-muted-foreground">
                  Private key {isEdit && "(leave blank to keep the saved one)"}
                </span>
                <textarea
                  value={form.privateKey ?? ""}
                  onChange={(e) => set("privateKey", e.target.value)}
                  placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
                  spellCheck={false}
                  rows={4}
                  className={cn(
                    "w-full resize-y rounded-lg border border-border bg-secondary px-3 py-2",
                    "font-mono text-xs text-foreground placeholder:text-muted-foreground/40",
                    "outline-none transition-colors focus:border-primary",
                  )}
                />
              </label>
              <CredInput
                label="Key passphrase (if encrypted)"
                value={form.passphrase ?? ""}
                onChange={(v) => set("passphrase", v)}
                type="password"
                placeholder="Leave blank if none"
              />
            </>
          ) : (
            <CredInput
              label={`Password${isEdit ? " (leave blank to keep the saved one)" : ""}`}
              value={form.password ?? ""}
              onChange={(v) => set("password", v)}
              type="password"
              placeholder="••••••••"
            />
          )}
        </>
      )}

      {form.kind === "webdav" && (
        <>
          <CredInput
            label="WebDAV URL"
            value={form.host}
            onChange={(v) => set("host", v)}
            placeholder="https://cloud.example.com/remote.php/dav/files/me"
          />
          <CredInput
            label="Username"
            value={form.username}
            onChange={(v) => set("username", v)}
            placeholder="me"
          />
          <CredInput
            label={`Password${isEdit ? " (leave blank to keep the saved one)" : ""}`}
            value={form.password ?? ""}
            onChange={(v) => set("password", v)}
            type="password"
            placeholder="••••••••"
          />
        </>
      )}

      {form.kind === "s3" && (
        <>
          <CredInput
            label="Endpoint URL"
            value={form.host}
            onChange={(v) => set("host", v)}
            placeholder="https://s3.us-west-002.backblazeb2.com"
          />
          <div className="flex gap-2">
            <div className="flex-1">
              <CredInput
                label="Bucket"
                value={form.bucket ?? ""}
                onChange={(v) => set("bucket", v)}
                placeholder="courses"
              />
            </div>
            <div className="flex-1">
              <CredInput
                label="Region"
                value={form.region ?? ""}
                onChange={(v) => set("region", v)}
                placeholder="us-east-1"
              />
            </div>
          </div>
          <CredInput
            label="Access key ID"
            value={form.username}
            onChange={(v) => set("username", v)}
            placeholder="AKIA…"
          />
          <CredInput
            label={`Secret access key${isEdit ? " (leave blank to keep the saved one)" : ""}`}
            value={form.password ?? ""}
            onChange={(v) => set("password", v)}
            type="password"
            placeholder="••••••••"
          />
          <label className="flex items-center gap-2.5 px-2">
            <input
              type="checkbox"
              checked={form.pathStyle ?? true}
              onChange={(e) => set("pathStyle", e.target.checked)}
              className="size-4 accent-primary"
            />
            <span className="font-sans text-xs text-muted-foreground">
              Path-style URLs — needed for MinIO and most self-hosted gateways. Turn off
              for AWS and Cloudflare R2.
            </span>
          </label>
        </>
      )}

      <CredInput
        label="Start folder"
        value={form.basePath ?? "/"}
        onChange={(v) => set("basePath", v)}
        placeholder={form.kind === "s3" ? "/" : "/srv/courses"}
      />

      <div className="flex items-center justify-between gap-2 px-2">
        <button
          onClick={onTest}
          disabled={busy || testing}
          className={cn(
            "flex items-center gap-1.5 rounded-lg border border-border px-3 py-2",
            "font-sans text-sm text-muted-foreground transition-colors",
            "hover:text-foreground disabled:opacity-50",
          )}
        >
          {testing ? (
            <SpinnerGap className="size-4 animate-spin" />
          ) : (
            <PlugsConnected className="size-4" />
          )}
          Test connection
        </button>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2 font-sans text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={busy || testing}
            className={cn(
              "rounded-lg bg-primary px-4 py-2 font-sans text-sm font-semibold text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50",
            )}
          >
            {isEdit ? "Save changes" : "Add server"}
          </button>
        </div>
      </div>
    </div>
  );
}
