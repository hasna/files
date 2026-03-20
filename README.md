# @hasna/files

Agent-first file management — index local folders and S3 buckets, tag, search, and retrieve files via CLI + MCP.

## Install

```bash
bun install -g @hasna/files
```

## CLI

```bash
# Add sources
files sources add ./my-documents
files sources add s3://my-bucket --region us-east-1 --access-key KEY --secret-key SECRET

# Index
files index                          # index all sources on this machine
files index src_abc123               # index one source

# Search & list
files search "invoice 2024"
files list --tag important --ext pdf
files list --source src_abc123

# File operations
files info f_abc123
files tag f_abc123 invoice important
files untag f_abc123 invoice
files download f_abc123              # downloads to ~/Downloads/<name>
files upload ./report.pdf src_abc123

# Organize
files collections create "Q1 Reports"
files collections add col_abc123 f_abc123
files projects create "Tax 2025"
files projects add prj_abc123 f_abc123

# Multi-machine sync
files sync http://192.168.1.10:19432

# Info
files machines
files tags
files sources list
files db                             # show DB path
```

## MCP Server

Add to your `claude_desktop_config.json` or `.mcp.json`:

```json
{
  "mcpServers": {
    "files": {
      "command": "files-mcp"
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `list_sources` | List configured sources |
| `add_source` | Add local or S3 source |
| `remove_source` | Remove a source |
| `index_source` | Re-index source(s) |
| `list_files` | List files with filters |
| `search_files` | Full-text search |
| `get_file` | Get file details |
| `download_file` | Download file to disk |
| `upload_file` | Upload file to S3 |
| `list_tags` | List all tags |
| `tag_file` | Tag a file |
| `untag_file` | Remove tags |
| `list_collections` | List collections |
| `create_collection` | Create collection |
| `add_to_collection` | Add file to collection |
| `list_projects` | List projects |
| `create_project` | Create project |
| `add_to_project` | Add file to project |
| `list_machines` | List known machines |

## REST API

```bash
files-serve               # starts on port 19432
files-serve --port 8080
```

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sources` | GET, POST | List / create sources |
| `/sources/:id` | DELETE | Remove source |
| `/sources/:id/index` | POST | Index source |
| `/files` | GET | List/search files (`?q=`, `?tag=`, `?ext=`, `?source_id=`) |
| `/files/:id` | GET | Get file |
| `/files/:id/download` | GET | Download file |
| `/files/:id/tags` | POST, DELETE | Tag / untag |
| `/tags` | GET | List tags |
| `/collections` | GET, POST | List / create |
| `/collections/:id/files` | POST | Add file |
| `/collections/:id/files/:fid` | DELETE | Remove file |
| `/projects` | GET, POST | List / create |
| `/projects/:id/files` | POST | Add file |
| `/machines` | GET | List machines |
| `/machines/current` | GET | Current machine |
| `/sync` | POST | Sync from peers `{ peers: ["http://..."] }` |
| `/health` | GET | Health check |

## Dashboard

```bash
files-serve   # then open http://localhost:19432
```

Or in dev: `cd dashboard && bun run dev`

## Multi-machine sync

Each machine has its own SQLite database at `~/.files/files.db`. To sync file indexes between machines:

```bash
# On machine B, pull from machine A
files sync http://machine-a.local:19432

# Or via API
curl -X POST http://localhost:19432/sync \
  -H "Content-Type: application/json" \
  -d '{"peers": ["http://machine-a.local:19432"]}'
```

This merges remote file records into your local DB so you can search across all machines.

## Storage

- **SQLite DB**: `~/.files/files.db` (override with `FILES_DB_PATH`)
- **Data dir**: `~/.files/` (override with `FILES_DATA_DIR`)
- **S3 credentials**: stored per source in the DB config column (JSON)
- **Hashing**: BLAKE3 via `@noble/hashes`

## License

MIT
