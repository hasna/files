// DB layer
export { getDb, DB_PATH } from "./db/database.js";

// DB — PostgreSQL migrations
export { PG_MIGRATIONS } from "./db/pg-migrations.js";
export { getCurrentMachine, listMachines, getMachine, upsertMachine } from "./db/machines.js";
export { createSource, getSource, listSources, updateSource, deleteSource, markSourceIndexed } from "./db/sources.js";
export { upsertFile, getFile, listFiles, searchFiles as searchFilesDb, markFileDeleted, deleteFile, getFileByPath, refreshAllFts, annotateFile, getMaxSyncVersion, getFilesSince } from "./db/files.js";
export { listTags, getOrCreateTag, deleteTag, tagFile, untagFile, getFileTags } from "./db/tags.js";
export { createCollection, updateCollection, listCollections, getCollection, deleteCollection, addToCollection, removeFromCollection, autoPopulateCollection } from "./db/collections.js";
export { createProject, updateProject, listProjects, getProject, deleteProject, addToProject, removeFromProject } from "./db/projects.js";
export { searchFiles } from "./db/search.js";
export { registerAgent, getAgent, listAgents, updateAgentHeartbeat, setAgentFocus } from "./db/agents.js";
export { logActivity, getFileHistory, getAgentActivity, getSessionActivity } from "./db/activity.js";

// Lib
export { indexLocalSource } from "./lib/indexer.js";
export { indexS3Source, downloadFromS3, uploadToS3, deleteFromS3, headS3Object } from "./lib/s3.js";
export { watchSource, unwatchSource, stopAllWatchers } from "./lib/watcher.js";
export { hashFile, hashBuffer } from "./lib/hasher.js";
export { syncWithPeer, syncWithPeers } from "./lib/sync.js";
export { normalizeFileName, generateCanonicalName } from "./lib/normalize.js";

// Types
export type {
  Machine, Source, FileRecord, FileWithTags, Tag, Collection, Project,
  SearchResult, ListFilesOptions, IndexStats, SourceType, FileStatus, S3Config,
  Agent, AgentActivity, ActionType, AutoRules, ProjectStatus,
} from "./types/index.js";
