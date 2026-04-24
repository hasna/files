# @hasna/files

Agent-first file management — index local folders and S3 buckets, sync Google Drive, tag, search, and retrieve files via CLI + MCP

[![npm](https://img.shields.io/npm/v/@hasna/files)](https://www.npmjs.com/package/@hasna/files)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
bun install -g @hasna/files
```

## CLI Usage

```bash
files --help
```

## Google Drive Sync

Google Drive sync uses profiles configured through the connectors CLI:

```bash
connectors auth googledrive
```

Add an S3 destination once. Google Drive sources auto-use the first enabled S3
source by default:

```bash
files sources add s3://my-files-bucket/google-drive --region us-east-1
files sources add-google-drive --all-profiles --all
files sources sync-google-drive
```

To sync into local storage instead, add a local source and pass it as the
destination:

```bash
files sources add ~/Files/google-drive-imports --name drive-local
files sources add-google-drive --profile personal --all --destination-source <local-source-id>
```

Synced files are indexed under the actual S3 or local destination source, so
`files download`, `files where`, and MCP file tools operate on the stored copy.

## MCP Server

```bash
files-mcp
```

31 tools available.

## REST API

```bash
files-serve
```

## Cloud Sync

This package supports cloud sync via `@hasna/cloud`:

```bash
cloud setup
cloud sync push --service files
cloud sync pull --service files
```

## Data Directory

Data is stored in `~/.hasna/files/`.

## License

Apache-2.0 -- see [LICENSE](LICENSE)
