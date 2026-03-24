# @hasna/files

Agent-first file management — index local folders and S3 buckets, tag, search, and retrieve files via CLI + MCP

[![npm](https://img.shields.io/npm/v/@hasna/files)](https://www.npmjs.com/package/@hasna/files)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

## Install

```bash
npm install -g @hasna/files
```

## CLI Usage

```bash
files --help
```

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
