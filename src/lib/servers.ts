import { invoke } from "@tauri-apps/api/core";
import type { ParsedCourse } from "@/types";

export type ServerKind = "sftp" | "webdav" | "s3";

/** A saved server. Secrets are never sent to the frontend — they stay in the OS keychain. */
export interface ServerConfig {
  id: string;
  name: string;
  kind: ServerKind;
  /** SFTP: hostname. WebDAV: base URL. S3: endpoint URL. */
  host: string;
  port: number;
  /** SFTP/WebDAV: username. S3: access key id. */
  username: string;
  basePath: string;
  bucket: string;
  region: string;
  pathStyle: boolean;
  /** SFTP only — the host key pinned on first connect. */
  hostFingerprint: string | null;
}

/** One entry in a remote directory listing. */
export interface RemoteNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
}

export interface BrowseResult {
  path: string;
  /** null at the configured base path — there's nowhere further up to go. */
  parent: string | null;
  entries: RemoteNode[];
}

/**
 * What the Settings form sends. Secrets are optional on edit: leaving
 * `password`/`privateKey` empty keeps whatever is already in the keychain, so
 * the form never has to read a stored secret back out.
 */
export interface ServerInput {
  id?: string;
  name: string;
  kind: ServerKind;
  host: string;
  port?: number;
  username: string;
  basePath?: string;
  bucket?: string;
  region?: string;
  pathStyle?: boolean;
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export const SERVER_KIND_LABELS: Record<ServerKind, string> = {
  sftp: "SFTP / SSH",
  webdav: "WebDAV",
  s3: "S3-compatible",
};

export async function getServers(): Promise<ServerConfig[]> {
  return invoke<ServerConfig[]>("get_servers");
}

export async function saveServer(input: ServerInput): Promise<ServerConfig> {
  return invoke<ServerConfig>("save_server", { input });
}

export async function deleteServer(id: string): Promise<void> {
  return invoke("delete_server", { id });
}

/** How many imported courses live on this server — they stop playing if it's removed. */
export async function countServerCourses(id: string): Promise<number> {
  return invoke<number>("count_server_courses", { id });
}

/** Connect with these settings without saving them. Resolves with a summary. */
export async function testServer(input: ServerInput): Promise<string> {
  return invoke<string>("test_server", { input });
}

/** One level of the remote filesystem, for the folder browser. */
export async function browseServer(
  serverId: string,
  path?: string,
): Promise<BrowseResult> {
  return invoke<BrowseResult>("browse_server", { serverId, path: path ?? null });
}

/** Walk a remote folder and build the same ParsedCourse the local parser produces. */
export async function parseServerFolder(
  serverId: string,
  path: string,
  name: string,
): Promise<ParsedCourse> {
  return invoke<ParsedCourse>("parse_server_folder", { serverId, path, name });
}

/** Default port for a kind, used to prefill the form. */
export function defaultPort(kind: ServerKind): number {
  return kind === "sftp" ? 22 : 443;
}

/** Lessons on a server are stored as `srv:<serverId>:<path>`. */
export function isServerPath(path: string): boolean {
  return path.startsWith("srv:");
}

/** Split a stored `srv:` path into its server id and remote path. */
export function splitServerPath(path: string): { serverId: string; path: string } | null {
  if (!isServerPath(path)) return null;
  const rest = path.slice("srv:".length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return null;
  return { serverId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}
