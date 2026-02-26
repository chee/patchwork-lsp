import type { AutomergeUrl, DocHandle } from "@automerge/vanillajs";

export type FolderDoc = {
  title: string;
  docs: DocLink[];
  lastSyncAt?: number;
};

export type DocLink = {
  name: string;
  type: string;
  url: AutomergeUrl;
  icon?: string;
  copyOf?: AutomergeUrl;
};

export type UnixFileEntry = {
  content: string;
  extension: string;
  mimeType: string;
  name: string;
};

export interface FileMapping {
  localPath: string;
  automergeUrl: AutomergeUrl;
  docHandle: DocHandle<UnixFileEntry>;
  name: string;
}
