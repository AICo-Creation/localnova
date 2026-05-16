import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_APP_PORT = 3001;
const APP_CONFIG_FILE = path.join(__dirname, "local-nova.config.json");
const APP_STATE_FILE = path.join(__dirname, "local-nova-data.json");
const PROJECT_UPLOAD_DIR = path.join(__dirname, "local-nova-project-files");
const LOCAL_NOVA_HP_DIR = path.join(__dirname, "local-nova-hp");
const HOST = process.env.HOST || "127.0.0.1";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "";
const AUTO_OPEN_BROWSER = process.env.AUTO_OPEN_BROWSER === "1";
const WIKIPEDIA_API_URL = "https://ja.wikipedia.org/w/api.php";
const WIKIPEDIA_SEARCH_LIMIT = 5;
const WIKIPEDIA_EXTRACT_CHARS = 700;
const ARXIV_API_URL = "https://export.arxiv.org/api/query";
const ARXIV_SEARCH_LIMIT = 5;
const ARXIV_SUMMARY_CHARS = 900;
const PUBMED_EUTILS_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const PUBMED_SEARCH_LIMIT = 5;
const PUBMED_ABSTRACT_CHARS = 900;
const SEARXNG_SEARCH_LIMIT = 5;
const WEB_SEARCH_PROVIDERS = new Set(["wikimedia", "arxiv", "pubmed", "searxng"]);
const SEARCH_AGENT_MAX_QUERIES = 5;
const SEARCH_AGENT_QUERY_MAX_LENGTH = 120;
const SEARCH_AGENT_PROMPT_MAX_LENGTH = 4000;
const PROJECT_UPLOAD_MAX_BYTES = 256 * 1024 * 1024; // 256 MB
const PROJECT_UPLOAD_ALLOWED_EXTENSIONS = new Set([
  // テキスト系
  ".txt", ".md", ".markdown",
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx",
  ".json", ".csv", ".tsv",
  ".yaml", ".yml", ".toml", ".ini", ".env",
  ".xml", ".svg",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs", ".swift", ".kt", ".php",
  ".sh", ".bash", ".zsh",
  ".sql", ".log", ".conf",
  // バイナリ系
  ".pdf", ".jpeg", ".jpg", ".png",
]);
const PROJECT_UPLOAD_EXTENSION_BY_MIME = {
  "application/pdf": ".pdf",
  "application/javascript": ".js",
  "application/x-javascript": ".js",
  "application/json": ".json",
  "application/xml": ".xml",
  "application/x-yaml": ".yaml",
  "application/x-toml": ".toml",
  "application/sql": ".sql",
  "application/x-sh": ".sh",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "text/css": ".css",
  "text/html": ".html",
  "text/javascript": ".js",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/tab-separated-values": ".tsv",
  "text/xml": ".xml",
  "text/x-python": ".py",
  "text/x-shellscript": ".sh",
};
const SYSTEM_MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SYSTEM_PROFILE_SECTIONS = [
  ["goal.md", "goal"],
  ["concept.md", "concept"],
  ["memory.md", "memory"],
  ["rules.md", "rules"],
  ["character.md", "character"],
  ["emotion.md", "emotion"],
  ["thinking.md", "thinking"],
  ["style.md", "style"],
];

function parsePortValue(value, { min = 1, max = 65535 } = {}) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= min && value <= max ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const port = Number(trimmed);
  return Number.isInteger(port) && port >= min && port <= max ? port : null;
}

function readAppConfig() {
  if (!existsSync(APP_CONFIG_FILE)) {
    return {};
  }

  try {
    const raw = readFileSync(APP_CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonFileAtomically(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, payload, "utf8");
  await rename(tempPath, filePath);
}

function readConfiguredAppPort() {
  const config = readAppConfig();
  const configuredPort = parsePortValue(config?.appPort, { min: 1024 });
  return configuredPort === DEFAULT_APP_PORT ? null : configuredPort;
}

async function writeAppConfig(config) {
  await writeJsonFileAtomically(APP_CONFIG_FILE, config);
}

async function readSavedAppStateFile() {
  if (!existsSync(APP_STATE_FILE)) {
    return {
      exists: false,
      state: null,
      storagePath: APP_STATE_FILE,
    };
  }

  try {
    const raw = await readFile(APP_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("保存ファイルの形式が不正です。");
    }

    return {
      exists: true,
      state: parsed,
      storagePath: APP_STATE_FILE,
    };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "保存ファイルの読み込みに失敗しました。");
  }
}

async function writeSavedAppStateFile(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new Error("保存するデータ形式が不正です。");
  }

  await writeJsonFileAtomically(APP_STATE_FILE, state);
  return {
    exists: true,
    storagePath: APP_STATE_FILE,
  };
}

const configuredAppPort = readConfiguredAppPort();
const environmentPort = parsePortValue(process.env.PORT);
const PORT = environmentPort ?? configuredAppPort ?? DEFAULT_APP_PORT;
const PORT_SOURCE =
  environmentPort !== null ? "environment" : configuredAppPort !== null ? "settings" : "default";

function normalizeModelName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) {
    return "";
  }

  const lastSlashIndex = value.lastIndexOf("/");
  const lastColonIndex = value.lastIndexOf(":");
  if (lastColonIndex > lastSlashIndex) {
    return value;
  }

  return `${value}:latest`;
}

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeSearchQuery(value) {
  const query = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return query.slice(0, 240);
}

function normalizeSearchProviders(value) {
  if (!Array.isArray(value)) {
    return ["wikimedia"];
  }

  const providers = value.filter((provider) => WEB_SEARCH_PROVIDERS.has(provider));
  return providers.length ? [...new Set(providers)] : ["wikimedia"];
}

function isSafeSearchAgentQuery(value) {
  const query = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!query || query.length > SEARCH_AGENT_QUERY_MAX_LENGTH) {
    return false;
  }
  if (/https?:\/\//i.test(query) || /\bwww\./i.test(query)) {
    return false;
  }
  if (/[`{}<>]/.test(query)) {
    return false;
  }
  return true;
}

function parseSearchAgentJson(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("サーチエージェントの出力が空です。");
  }

  const withoutFence = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(withoutFence);
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(withoutFence.slice(start, end + 1));
    }
    throw new Error("サーチエージェントのJSONを解析できませんでした。");
  }
}

function validateSearchAgentPlan(plan, fallbackPrompt) {
  const intent =
    typeof plan?.intent === "string" && plan.intent.trim()
      ? truncateText(plan.intent, 180)
      : truncateText(`${fallbackPrompt}について調べる`, 180);
  const rawQueries = Array.isArray(plan?.queries) ? plan.queries : [];
  const queries = [];
  const seen = new Set();

  rawQueries.forEach((item) => {
    const query = typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "";
    const key = query.toLocaleLowerCase();
    if (!isSafeSearchAgentQuery(query) || seen.has(key)) {
      return;
    }
    seen.add(key);
    queries.push(query);
  });

  return {
    intent,
    queries: queries.slice(0, SEARCH_AGENT_MAX_QUERIES),
  };
}

function normalizeSearchAgentContext(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, 5000) : "";
}

function normalizeSearchAgentPrompt(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim().slice(0, SEARCH_AGENT_PROMPT_MAX_LENGTH) : "";
}

function truncateText(value, maxLength) {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text || text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function decodeXmlEntities(value) {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function stripXmlTags(value) {
  return decodeXmlEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function getXmlText(block, tagName) {
  const match = String(block || "").match(new RegExp(`<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? stripXmlTags(match[1]) : "";
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`検索APIエラー: ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`検索APIエラー: ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function searchWikipedia(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw new Error("検索語が空です。");
  }

  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: normalizedQuery,
    gsrlimit: String(WIKIPEDIA_SEARCH_LIMIT),
    gsrnamespace: "0",
    prop: "extracts|info",
    exintro: "1",
    explaintext: "1",
    exchars: String(WIKIPEDIA_EXTRACT_CHARS),
    inprop: "url",
    redirects: "1",
    utf8: "1",
  });

  const data = await fetchJsonWithTimeout(`${WIKIPEDIA_API_URL}?${params.toString()}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
    },
  });

  const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
  const indexByPageId = new Map(
    Array.isArray(data?.query?.search)
      ? data.query.search.map((item, index) => [item.pageid, index])
      : [],
  );

  return pages
    .map((page) => ({
      source: "Wikipedia",
      title: truncateText(page?.title, 120),
      url: typeof page?.fullurl === "string" ? page.fullurl : "",
      summary: truncateText(page?.extract, WIKIPEDIA_EXTRACT_CHARS),
      rank:
        typeof page?.index === "number"
          ? page.index
          : indexByPageId.has(page?.pageid)
            ? indexByPageId.get(page.pageid)
            : Number.MAX_SAFE_INTEGER,
    }))
    .filter((item) => item.title || item.summary)
    .sort((a, b) => a.rank - b.rank)
    .map(({ rank, ...item }) => item);
}

async function searchArxiv(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw new Error("検索語が空です。");
  }

  const params = new URLSearchParams({
    search_query: `all:${normalizedQuery}`,
    start: "0",
    max_results: String(ARXIV_SEARCH_LIMIT),
    sortBy: "relevance",
    sortOrder: "descending",
  });
  const xml = await fetchTextWithTimeout(
    `${ARXIV_API_URL}?${params.toString()}`,
    {
      headers: {
        "Accept": "application/atom+xml, application/xml, text/xml",
        "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
      },
    },
    15000,
  );

  const entries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  return entries
    .map((entry) => {
      const id = getXmlText(entry, "id");
      const title = getXmlText(entry, "title");
      const summary = getXmlText(entry, "summary");
      const published = getXmlText(entry, "published").slice(0, 10);
      const authors = [...entry.matchAll(/<author[\s\S]*?<name(?:\s[^>]*)?>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
        .map((match) => stripXmlTags(match[1]))
        .filter(Boolean)
        .slice(0, 4);

      return {
        source: "arXiv",
        title: truncateText(title, 160),
        url: id,
        summary: truncateText(
          [authors.length ? `著者: ${authors.join(", ")}` : "", published ? `公開日: ${published}` : "", summary]
            .filter(Boolean)
            .join(" / "),
          ARXIV_SUMMARY_CHARS,
        ),
      };
    })
    .filter((item) => item.title || item.summary);
}

async function fetchPubMedAbstracts(ids) {
  if (!ids.length) {
    return new Map();
  }

  const params = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "xml",
  });
  const xml = await fetchTextWithTimeout(`${PUBMED_EUTILS_URL}/efetch.fcgi?${params.toString()}`, {
    headers: {
      "Accept": "application/xml, text/xml",
      "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
    },
  });
  const articles = xml.match(/<PubmedArticle[\s\S]*?<\/PubmedArticle>/gi) || [];
  const abstracts = new Map();

  articles.forEach((article) => {
    const pmid = getXmlText(article, "PMID");
    const abstractParts = [...article.matchAll(/<AbstractText(?:\s[^>]*)?>([\s\S]*?)<\/AbstractText>/gi)]
      .map((match) => stripXmlTags(match[1]))
      .filter(Boolean);
    if (pmid && abstractParts.length) {
      abstracts.set(pmid, abstractParts.join(" "));
    }
  });

  return abstracts;
}

async function searchPubMed(query) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw new Error("検索語が空です。");
  }

  const searchParams = new URLSearchParams({
    db: "pubmed",
    term: normalizedQuery,
    retmode: "json",
    retmax: String(PUBMED_SEARCH_LIMIT),
    sort: "relevance",
  });
  const searchData = await fetchJsonWithTimeout(`${PUBMED_EUTILS_URL}/esearch.fcgi?${searchParams.toString()}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
    },
  });
  const ids = Array.isArray(searchData?.esearchresult?.idlist) ? searchData.esearchresult.idlist : [];
  if (!ids.length) {
    return [];
  }

  const summaryParams = new URLSearchParams({
    db: "pubmed",
    id: ids.join(","),
    retmode: "json",
  });
  const [summaryData, abstracts] = await Promise.all([
    fetchJsonWithTimeout(`${PUBMED_EUTILS_URL}/esummary.fcgi?${summaryParams.toString()}`, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
      },
    }),
    fetchPubMedAbstracts(ids).catch(() => new Map()),
  ]);

  return ids
    .map((id) => {
      const item = summaryData?.result?.[id] || {};
      const authors = Array.isArray(item.authors)
        ? item.authors.map((author) => author?.name).filter(Boolean).slice(0, 4)
        : [];
      const pubDate = typeof item.pubdate === "string" ? item.pubdate : "";
      const journal = typeof item.fulljournalname === "string" ? item.fulljournalname : "";
      const title = typeof item.title === "string" ? item.title : "";
      const abstract = abstracts.get(id) || "";

      return {
        source: "PubMed",
        title: truncateText(title, 180),
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        summary: truncateText(
          [
            authors.length ? `著者: ${authors.join(", ")}` : "",
            journal ? `掲載誌: ${journal}` : "",
            pubDate ? `公開日: ${pubDate}` : "",
            abstract ? `抄録: ${abstract}` : "",
          ]
            .filter(Boolean)
            .join(" / "),
          PUBMED_ABSTRACT_CHARS,
        ),
      };
    })
    .filter((item) => item.title || item.summary);
}

function normalizeSearxngBaseUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SearXNGのURLが不正です。");
  }

  const allowedHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const isPrivateLan =
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(parsed.hostname);
  if (!["http:", "https:"].includes(parsed.protocol) || (!allowedHosts.has(parsed.hostname) && !isPrivateLan)) {
    throw new Error("SearXNG自前ホストはlocalhostまたはプライベートIPだけ指定できます。");
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

async function searchSearxng(query, baseUrl) {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    throw new Error("検索語が空です。");
  }

  const normalizedBaseUrl = normalizeSearxngBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    throw new Error("SearXNG自前ホストのURLが未設定です。");
  }

  const params = new URLSearchParams({
    q: normalizedQuery,
    format: "json",
    language: "ja-JP",
    safesearch: "1",
  });
  const data = await fetchJsonWithTimeout(`${normalizedBaseUrl}/search?${params.toString()}`, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "AI-CoCreation-LOCAL-NOVA/1.0 (local search feature)",
    },
  });

  const results = Array.isArray(data?.results) ? data.results.slice(0, SEARXNG_SEARCH_LIMIT) : [];
  return results
    .map((item) => ({
      source: "SearXNG",
      title: truncateText(item?.title, 160),
      url: typeof item?.url === "string" ? item.url : "",
      summary: truncateText(item?.content || item?.snippet, 700),
    }))
    .filter((item) => item.title || item.summary);
}

const searchProviderHandlers = {
  wikimedia: {
    label: "Wikimedia API",
    search: (query) => searchWikipedia(query),
  },
  arxiv: {
    label: "arXiv API",
    search: (query) => searchArxiv(query),
  },
  pubmed: {
    label: "PubMed",
    search: (query) => searchPubMed(query),
  },
  searxng: {
    label: "SearXNG自前ホスト",
    search: (query, options) => searchSearxng(query, options?.searxngBaseUrl),
  },
};

async function searchWebProviders({ query, providers, searxngBaseUrl }) {
  const normalizedQuery = normalizeSearchQuery(query);
  const normalizedProviders = normalizeSearchProviders(providers);
  const searches = await Promise.allSettled(
    normalizedProviders.map(async (provider) => {
      const handler = searchProviderHandlers[provider];
      if (!handler) {
        throw new Error("未対応の検索先です。");
      }

      const results = await handler.search(normalizedQuery, { searxngBaseUrl });
      return {
        provider,
        label: handler.label,
        results,
        error: "",
      };
    }),
  );

  return searches.map((result, index) => {
    const provider = normalizedProviders[index];
    const label = searchProviderHandlers[provider]?.label || provider;
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      provider,
      label,
      results: [],
      error: result.reason instanceof Error ? result.reason.message : "検索に失敗しました。",
    };
  });
}

function normalizeMessages(messages = []) {
  return messages
    .filter((message) => message && typeof message.content === "string")
    .map((message) => ({
      role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
}

function normalizeSystemProfile(profile = {}) {
  const normalized = {};

  for (const [, key] of SYSTEM_PROFILE_SECTIONS) {
    normalized[key] = typeof profile?.[key] === "string" ? profile[key].trim() : "";
  }

  return normalized;
}

function buildSystemPrompt(profile = {}) {
  return SYSTEM_PROFILE_SECTIONS.map(([label, key]) => [label, profile[key] || ""])
    .filter(([, value]) => value)
    .map(([label, value]) => `# ${label}\n${value}`)
    .join("\n\n");
}

function sanitizeProjectUploadBaseName(fileName) {
  const baseName = path.basename(typeof fileName === "string" ? fileName : "", path.extname(typeof fileName === "string" ? fileName : ""));
  const normalized = baseName
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80);

  return normalized || "upload";
}

function resolveProjectUploadExtension(fileName, mimeType = "") {
  const rawExt = path.extname(typeof fileName === "string" ? fileName : "").toLowerCase();
  if (PROJECT_UPLOAD_ALLOWED_EXTENSIONS.has(rawExt)) {
    return rawExt;
  }

  const normalizedMimeType = typeof mimeType === "string" ? mimeType.split(";")[0].trim().toLowerCase() : "";
  return PROJECT_UPLOAD_EXTENSION_BY_MIME[normalizedMimeType] || "";
}

function parseDataUrlPayload(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    throw new Error("アップロードデータの形式が不正です。");
  }

  const match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error("アップロードデータの形式が不正です。");
  }

  return {
    mimeType: (match[1] || "application/octet-stream").toLowerCase(),
    buffer: Buffer.from(match[2].replace(/\s+/g, ""), "base64"),
  };
}

async function saveProjectUploadFile({ fileName, mimeType, dataUrl }) {
  const originalFileName = typeof fileName === "string" ? fileName.trim() : "";
  const resolvedExtension = resolveProjectUploadExtension(originalFileName, mimeType);
  if (!resolvedExtension) {
    throw new Error("対応しているのは txt / md / html / css / js / pdf / jpeg / jpg / png です。");
  }

  const { mimeType: detectedMimeType, buffer } = parseDataUrlPayload(dataUrl);
  if (!buffer.length) {
    throw new Error("空のファイルはアップロードできません。");
  }

  if (buffer.length > PROJECT_UPLOAD_MAX_BYTES) {
    throw new Error(`ファイルは ${PROJECT_UPLOAD_MAX_BYTES.toLocaleString("ja-JP")} バイト以内にしてください。`);
  }

  await mkdir(PROJECT_UPLOAD_DIR, { recursive: true });

  const safeBaseName = sanitizeProjectUploadBaseName(originalFileName);
  const storedName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeBaseName}${resolvedExtension}`;
  const filePath = path.join(PROJECT_UPLOAD_DIR, storedName);
  await writeFile(filePath, buffer);

  return {
    fileName: originalFileName || `${safeBaseName}${resolvedExtension}`,
    mimeType: detectedMimeType || mimeType || "application/octet-stream",
    size: buffer.length,
    storagePath: filePath,
    url: `/project-files/${encodeURIComponent(storedName)}`,
  };
}

async function fetchModels() {
  const response = await fetch(`${OLLAMA_URL}/api/tags`);
  if (!response.ok) {
    throw new Error(`モデル一覧の取得に失敗しました: ${response.status}`);
  }

  const data = await response.json();
  const models = Array.isArray(data.models) ? data.models : [];

  return models.map((model) => ({
    name: model.name,
    size: model.size,
    modifiedAt: model.modified_at,
  }));
}

async function createDerivedModel({ baseModel, derivedModelName, systemPrompt }) {
  const response = await fetch(`${OLLAMA_URL}/api/create`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: baseModel,
      model: derivedModelName,
      system: systemPrompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`派生モデル作成エラー: ${response.status} ${text}`);
  }

  return response.json();
}

async function deleteOllamaModel(modelName) {
  const response = await fetch(`${OLLAMA_URL}/api/delete`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: modelName }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`既存モデルの削除に失敗しました: ${response.status} ${text}`);
  }
}

function extractThoughtAndReply(data) {
  const rawContent = data?.message?.content || "";
  const explicitThinking =
    typeof data?.message?.thinking === "string" ? data.message.thinking.trim() : "";

  const thinkTagPattern = /<think>([\s\S]*?)<\/think>/gi;
  const thinkMatches = [...rawContent.matchAll(thinkTagPattern)];
  const taggedThinking = thinkMatches
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean)
    .join("\n\n");

  const reply = rawContent.replace(thinkTagPattern, "").trim();
  const thought = explicitThinking || taggedThinking;
  const doneReason =
    typeof data?.done_reason === "string" && data.done_reason ? data.done_reason : "";

  return {
    reply,
    thought,
    doneReason,
  };
}

function normalizeContextWindow(value) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function buildOllamaChatPayload({
  model,
  messages,
  profileSystemPrompt,
  systemPrompt,
  customPrompt,
  temperature,
  contextWindow,
  stream = false,
}) {
  const options = {};
  if (typeof temperature === "number" && Number.isFinite(temperature) && temperature >= 0) {
    options.temperature = temperature;
  }
  if (typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0) {
    options.num_ctx = contextWindow;
  }

  // Layering order (top = lowest / identity, bottom = highest / most specific):
  //   1) profileSystemPrompt — embedded persona / memory (would normally come from the
  //      derived model's Modelfile SYSTEM, but Ollama replaces that with any system
  //      message in `messages`, so we re-supply it here to keep memory alive).
  //   2) systemPrompt        — per-conversation / per-project session prompt.
  //   3) customPrompt        — global, lightweight standing instructions.
  return {
    model,
    stream,
    ...(Object.keys(options).length ? { options } : {}),
    messages: [
      ...(profileSystemPrompt && profileSystemPrompt.trim()
        ? [{ role: "system", content: profileSystemPrompt.trim() }]
        : []),
      ...(systemPrompt && systemPrompt.trim()
        ? [{ role: "system", content: systemPrompt.trim() }]
        : []),
      ...(customPrompt && customPrompt.trim()
        ? [{ role: "system", content: customPrompt.trim() }]
        : []),
      ...messages,
    ],
  };
}

function writeNdjson(res, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(`${JSON.stringify(payload)}\n`);
}

function extractStreamingTextDelta(previousValue, incomingValue) {
  const previousText = typeof previousValue === "string" ? previousValue : "";
  const incomingText = typeof incomingValue === "string" ? incomingValue : "";

  if (!incomingText) {
    return {
      delta: "",
      nextValue: previousText,
    };
  }

  if (incomingText.startsWith(previousText)) {
    return {
      delta: incomingText.slice(previousText.length),
      nextValue: incomingText,
    };
  }

  return {
    delta: incomingText,
    nextValue: previousText + incomingText,
  };
}

function getTrailingTagPrefixLength(value, tags) {
  const candidates = Array.isArray(tags) ? tags : [tags];
  let longest = 0;

  for (const tag of candidates) {
    const maxLength = Math.min(value.length, Math.max(0, tag.length - 1));
    for (let length = maxLength; length > longest; length -= 1) {
      if (value.endsWith(tag.slice(0, length))) {
        longest = length;
        break;
      }
    }
  }

  return longest;
}

function createThinkTagStreamParser() {
  return {
    buffer: "",
    insideThink: false,
  };
}

function consumeThinkTagStream(parser, chunk) {
  if (!parser || typeof parser !== "object") {
    return {
      visible: "",
      thinking: "",
    };
  }

  parser.buffer += typeof chunk === "string" ? chunk : "";
  let visible = "";
  let thinking = "";

  while (parser.buffer) {
    if (parser.insideThink) {
      const closeIndex = parser.buffer.indexOf("</think>");
      if (closeIndex >= 0) {
        thinking += parser.buffer.slice(0, closeIndex);
        parser.buffer = parser.buffer.slice(closeIndex + "</think>".length);
        parser.insideThink = false;
        continue;
      }

      const trailingPrefixLength = getTrailingTagPrefixLength(parser.buffer, "</think>");
      const safeLength = Math.max(0, parser.buffer.length - trailingPrefixLength);
      if (safeLength > 0) {
        thinking += parser.buffer.slice(0, safeLength);
        parser.buffer = parser.buffer.slice(safeLength);
      }
      break;
    }

    const openIndex = parser.buffer.indexOf("<think>");
    const closeIndex = parser.buffer.indexOf("</think>");

    if (closeIndex >= 0 && (openIndex === -1 || closeIndex < openIndex)) {
      visible += parser.buffer.slice(0, closeIndex);
      parser.buffer = parser.buffer.slice(closeIndex + "</think>".length);
      continue;
    }

    if (openIndex >= 0) {
      visible += parser.buffer.slice(0, openIndex);
      parser.buffer = parser.buffer.slice(openIndex + "<think>".length);
      parser.insideThink = true;
      continue;
    }

    const trailingPrefixLength = getTrailingTagPrefixLength(parser.buffer, ["<think>", "</think>"]);
    const safeLength = Math.max(0, parser.buffer.length - trailingPrefixLength);
    if (safeLength > 0) {
      visible += parser.buffer.slice(0, safeLength);
      parser.buffer = parser.buffer.slice(safeLength);
    }
    break;
  }

  return {
    visible,
    thinking,
  };
}

function flushThinkTagStream(parser) {
  if (!parser || typeof parser !== "object") {
    return {
      visible: "",
      thinking: "",
    };
  }

  if (parser.insideThink) {
    const thinking = parser.buffer;
    parser.buffer = "";
    return {
      visible: "",
      thinking,
    };
  }

  const visible = parser.buffer.replace(/<\/?think>/gi, "");
  parser.buffer = "";
  return {
    visible,
    thinking: "",
  };
}

function isAbortError(error) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

async function chatWithOllama({ model, messages, profileSystemPrompt, systemPrompt, customPrompt, temperature, contextWindow, signal }) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify(
      buildOllamaChatPayload({
        model,
        messages,
        profileSystemPrompt,
        systemPrompt,
        customPrompt,
        temperature,
        contextWindow,
        stream: false,
      }),
    ),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama応答エラー: ${response.status} ${text}`);
  }

  const data = await response.json();
  return extractThoughtAndReply(data);
}

function buildSearchAgentSystemPrompt(customPrompt = "") {
  const normalizedCustomPrompt = normalizeSearchAgentPrompt(customPrompt);
  if (normalizedCustomPrompt) {
    return normalizedCustomPrompt;
  }

  return [
    "あなたは検索前処理だけを行うサーチエージェントです。",
    "ユーザーの入力と初回キーワード検索結果を読み、検索APIへ渡す関連キーワードを最大5件に派生させてください。",
    "初回キーワード検索結果に含まれる事実を優先し、人物・組織・時代・分野を取り違えないでください。",
    "検索意図から外れる固有名詞を安易に追加しないでください。",
    "返答は必ずJSONオブジェクトだけにしてください。Markdown、説明文、コードブロックは禁止です。",
    "JSONのキーは intent と queries だけです。",
    "intent は日本語で1文、queries は検索語文字列の配列です。",
    "URL、コード、命令文、空文字、重複クエリは含めないでください。",
  ].join("\n");
}

function buildSearchAgentUserPrompt(normalizedPrompt, normalizedSearchContext) {
  return [
    "次のユーザープロンプトと初回キーワード検索結果から、検索意図と関連検索キーワードを作ってください。",
    "初回検索結果にない関係性を強く仮定せず、まず中心人物・中心テーマに近い検索語を優先してください。",
    "出力形式:",
    "{\"intent\":\"...\",\"queries\":[\"...\",\"...\",\"...\",\"...\",\"...\"]}",
    "",
    `[ユーザープロンプト]\n${normalizedPrompt}`,
    "",
    normalizedSearchContext ? `[初回キーワード検索結果]\n${normalizedSearchContext}` : "[初回キーワード検索結果]\n検索結果: なし",
  ].join("\n");
}

async function createSearchAgentPlan({ prompt, searchContext, searchAgentPrompt, model, contextWindow, signal }) {
  const normalizedPrompt = normalizeSearchQuery(prompt);
  const normalizedSearchContext = normalizeSearchAgentContext(searchContext);
  if (!normalizedPrompt) {
    throw new Error("検索計画の元になるプロンプトが空です。");
  }

  const systemPrompt = buildSearchAgentSystemPrompt(searchAgentPrompt);
  const userPrompt = buildSearchAgentUserPrompt(normalizedPrompt, normalizedSearchContext);
  const result = await chatWithOllama({
    model,
    systemPrompt,
    customPrompt: "",
    temperature: 0.2,
    contextWindow,
    signal,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
  });

  const parsed = parseSearchAgentJson(result.reply);
  const plan = validateSearchAgentPlan(parsed, normalizedPrompt);
  if (!plan.queries.length) {
    throw new Error("サーチエージェントが有効な検索キーワードを作成できませんでした。");
  }
  return {
    ...plan,
    raw: result.reply,
    debug: {
      systemPrompt,
      userPrompt,
      rawOutput: result.reply,
    },
  };
}

async function readNdjsonStream(stream, onMessage) {
  if (!stream) {
    throw new Error("Ollamaの段階的出力を取得できませんでした。");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  const consumeBuffer = () => {
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line) {
        onMessage(JSON.parse(line));
      }

      newlineIndex = buffer.indexOf("\n");
    }
  };

  if (typeof stream.getReader === "function") {
    const reader = stream.getReader();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        consumeBuffer();
      }

      buffer += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      consumeBuffer();
    }

    buffer += decoder.decode();
  }

  const tail = buffer.trim();
  if (tail) {
    onMessage(JSON.parse(tail));
  }
}

async function streamChatWithOllama({
  model,
  messages,
  profileSystemPrompt,
  systemPrompt,
  customPrompt,
  temperature,
  contextWindow,
  signal,
  onStart,
  onDelta,
  onThinkingDelta,
  onDone,
}) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify(
      buildOllamaChatPayload({
        model,
        messages,
        profileSystemPrompt,
        systemPrompt,
        customPrompt,
        temperature,
        contextWindow,
        stream: true,
      }),
    ),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama応答エラー: ${response.status} ${text}`);
  }

  if (!response.body) {
    throw new Error("Ollamaの段階的出力を取得できませんでした。");
  }

  let resolvedModel = model;
  let rawContent = "";
  let explicitThinking = "";
  let receivedExplicitThinking = false;
  let resolvedDoneReason = "";
  const visibleReplyParser = createThinkTagStreamParser();

  if (typeof onStart === "function") {
    onStart({ model: resolvedModel });
  }

  await readNdjsonStream(response.body, (data) => {
    if (!data || typeof data !== "object") {
      return;
    }

    if (typeof data.error === "string" && data.error) {
      throw new Error(data.error);
    }

    if (typeof data.model === "string" && data.model) {
      resolvedModel = data.model;
    }

    if (typeof data?.done_reason === "string" && data.done_reason) {
      resolvedDoneReason = data.done_reason;
    }

    if (typeof data?.message?.thinking === "string" && data.message.thinking) {
      receivedExplicitThinking = true;
      const thinkingUpdate = extractStreamingTextDelta(explicitThinking, data.message.thinking);
      explicitThinking = thinkingUpdate.nextValue;

      if (thinkingUpdate.delta && typeof onThinkingDelta === "function") {
        onThinkingDelta({
          model: resolvedModel,
          content: thinkingUpdate.delta,
        });
      }
    }

    if (typeof data?.message?.content === "string" && data.message.content) {
      rawContent += data.message.content;

      const contentUpdate = consumeThinkTagStream(visibleReplyParser, data.message.content);
      if (contentUpdate.visible && typeof onDelta === "function") {
        onDelta({
          model: resolvedModel,
          content: contentUpdate.visible,
        });
      }

      if (!receivedExplicitThinking && contentUpdate.thinking && typeof onThinkingDelta === "function") {
        onThinkingDelta({
          model: resolvedModel,
          content: contentUpdate.thinking,
        });
      }
    }
  });

  const trailingContent = flushThinkTagStream(visibleReplyParser);
  if (trailingContent.visible && typeof onDelta === "function") {
    onDelta({
      model: resolvedModel,
      content: trailingContent.visible,
    });
  }

  if (!receivedExplicitThinking && trailingContent.thinking && typeof onThinkingDelta === "function") {
    onThinkingDelta({
      model: resolvedModel,
      content: trailingContent.thinking,
    });
  }

  const result = extractThoughtAndReply({
    message: {
      content: rawContent,
      thinking: explicitThinking,
    },
    done_reason: resolvedDoneReason,
  });

  if (typeof onDone === "function") {
    onDone({
      model: resolvedModel,
      reply: result.reply,
      thought: result.thought,
      doneReason: result.doneReason,
    });
  }
}

async function serveStatic(req, res) {
  const requestedPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, "public", safePath);

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function serveProjectUploadFile(req, res) {
  const requestPath = typeof req.url === "string" ? req.url : "";
  const relativePath = decodeURIComponent(requestPath.slice("/project-files/".length));
  const safeName = path.basename(relativePath);

  if (!safeName || safeName !== relativePath) {
    json(res, 404, { error: "Not found" });
    return;
  }

  const filePath = path.join(PROJECT_UPLOAD_DIR, safeName);

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function serveLocalNovaHpFile(req, res) {
  const requestPath = typeof req.url === "string" ? req.url.split("?")[0] : "";
  const rawRelativePath = decodeURIComponent(requestPath.slice("/local-nova-hp/".length));
  const relativePath = rawRelativePath || "local-nova-hero.html";
  const normalizedPath = path.normalize(relativePath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(LOCAL_NOVA_HP_DIR, normalizedPath);
  const hpRoot = path.resolve(LOCAL_NOVA_HP_DIR);

  if (!filePath.startsWith(`${hpRoot}${path.sep}`) && filePath !== hpRoot) {
    json(res, 404, { error: "Not found" });
    return;
  }

  try {
    const file = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(file);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

function getBrowserHost() {
  return HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
}

function buildConnectionSettingsPayload() {
  const manualPort = readConfiguredAppPort();
  const nextPort = manualPort ?? DEFAULT_APP_PORT;
  const browserHost = getBrowserHost();

  return {
    currentPort: PORT,
    currentUrl: `http://${browserHost}:${PORT}`,
    defaultPort: DEFAULT_APP_PORT,
    environmentOverride: environmentPort !== null,
    host: browserHost,
    manualPort: manualPort === null ? "" : String(manualPort),
    nextPort,
    nextUrl: `http://${browserHost}:${nextPort}`,
    source: PORT_SOURCE,
  };
}

async function isPortAvailable(port, host) {
  if (port === PORT) {
    return true;
  }

  return new Promise((resolve) => {
    const probe = createServer(() => {});

    probe.once("error", (error) => {
      if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (code === "EADDRINUSE" || code === "EACCES") {
          resolve(false);
          return;
        }
      }

      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });

    probe.listen(port, host);
  });
}

function openBrowser() {
  const browserHost = getBrowserHost();
  const url = `http://${browserHost}:${PORT}`;
  const child = spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && typeof req.url === "string" && req.url.startsWith("/project-files/")) {
      await serveProjectUploadFile(req, res);
      return;
    }

    if (req.method === "GET" && typeof req.url === "string" && req.url.startsWith("/local-nova-hp/")) {
      await serveLocalNovaHpFile(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/connection") {
      json(res, 200, buildConnectionSettingsPayload());
      return;
    }

    if (req.method === "POST" && req.url === "/api/connection") {
      const body = await readJson(req);
      const rawManualPort =
        typeof body.manualPort === "string"
          ? body.manualPort.trim()
          : body.manualPort === null || typeof body.manualPort === "undefined"
            ? ""
            : String(body.manualPort).trim();
      const parsedManualPort = rawManualPort ? parsePortValue(rawManualPort, { min: 1024 }) : null;

      if (rawManualPort && parsedManualPort === null) {
        json(res, 400, {
          error: "ポート番号は 1024 から 65535 の数字で入力してください。",
        });
        return;
      }

      const normalizedManualPort = parsedManualPort === DEFAULT_APP_PORT ? null : parsedManualPort;
      const nextPort = normalizedManualPort ?? DEFAULT_APP_PORT;
      const available = await isPortAvailable(nextPort, HOST);
      if (!available) {
        json(res, 409, {
          error: "このポートは使用中です。別の番号を入力してください。",
        });
        return;
      }

      const config = readAppConfig();
      config.appPort = normalizedManualPort;
      config.updatedAt = new Date().toISOString();
      await writeAppConfig(config);

      json(res, 200, buildConnectionSettingsPayload());
      return;
    }

    if (req.method === "GET" && req.url === "/api/storage/state") {
      const payload = await readSavedAppStateFile();
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && req.url === "/api/storage/state") {
      const body = await readJson(req);
      if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) {
        json(res, 400, {
          error: "保存するデータ形式が不正です。",
        });
        return;
      }

      const payload = await writeSavedAppStateFile(body.state);
      json(res, 200, payload);
      return;
    }

    if (req.method === "POST" && req.url === "/api/project-files") {
      const body = await readJson(req);
      const payload = await saveProjectUploadFile({
        fileName: typeof body.fileName === "string" ? body.fileName : "",
        mimeType: typeof body.mimeType === "string" ? body.mimeType : "",
        dataUrl: typeof body.dataUrl === "string" ? body.dataUrl : "",
      });
      json(res, 200, payload);
      return;
    }

    if (req.method === "GET" && req.url === "/api/models") {
      const models = await fetchModels();
      json(res, 200, {
        models,
        defaultModel: DEFAULT_MODEL,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/search/wikipedia") {
      const body = await readJson(req);
      const query = normalizeSearchQuery(body.query);

      if (!query) {
        json(res, 400, {
          error: "検索語が空です。",
        });
        return;
      }

      const results = await searchWikipedia(query);
      json(res, 200, {
        provider: "wikipedia",
        query,
        results,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/search/web") {
      const body = await readJson(req);
      const query = normalizeSearchQuery(body.query);

      if (!query) {
        json(res, 400, {
          error: "検索語が空です。",
        });
        return;
      }

      const providers = normalizeSearchProviders(body.providers);
      const providerResults = await searchWebProviders({
        query,
        providers,
        searxngBaseUrl: body.searxngBaseUrl,
      });
      json(res, 200, {
        query,
        providers,
        providerResults,
        results: providerResults.flatMap((providerResult) =>
          providerResult.results.map((item) => ({
            ...item,
            provider: providerResult.provider,
            providerLabel: providerResult.label,
          })),
        ),
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/search/query-plan") {
      const body = await readJson(req);
      const prompt = normalizeSearchQuery(body.prompt);
      const searchContext = normalizeSearchAgentContext(body.searchContext);
      const searchAgentPrompt = normalizeSearchAgentPrompt(body.searchAgentPrompt);
      const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
      const contextWindow = normalizeContextWindow(body.contextWindow);

      if (!prompt) {
        json(res, 400, {
          error: "検索計画の元になるプロンプトが空です。",
        });
        return;
      }

      const models = await fetchModels();
      const fallbackModel = DEFAULT_MODEL || models[0]?.name || "";
      const model = requestedModel || fallbackModel;

      if (!model) {
        json(res, 400, {
          error: "サーチエージェントに使えるモデルが見つかりません。Ollamaでモデルを追加してください。",
        });
        return;
      }

      const abortController = new AbortController();
      const abortSearchAgent = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };

      req.once("aborted", abortSearchAgent);
      res.once("close", abortSearchAgent);

      try {
        const plan = await createSearchAgentPlan({
          prompt,
          searchContext,
          searchAgentPrompt,
          model,
          contextWindow,
          signal: abortController.signal,
        });
        json(res, 200, {
          model,
          plan: {
            intent: plan.intent,
            queries: plan.queries,
          },
          debug: plan.debug,
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          return;
        }
        json(res, 500, {
          error: error instanceof Error ? error.message : "検索計画の作成に失敗しました。",
        });
      } finally {
        req.off("aborted", abortSearchAgent);
        res.off("close", abortSearchAgent);
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const body = await readJson(req);
      const messages = normalizeMessages(body.messages);
      const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
      const outputMode = body.outputMode === "progressive" ? "progressive" : "batch";
      const systemPrompt =
        typeof body.systemPrompt === "string" ? body.systemPrompt : "";
      const customPrompt =
        typeof body.customPrompt === "string" ? body.customPrompt : "";
      const profileSystemPrompt =
        typeof body.profileSystemPrompt === "string" ? body.profileSystemPrompt : "";
      const contextWindow = normalizeContextWindow(body.contextWindow);
      const temperature =
        typeof body.temperature === "number" && Number.isFinite(body.temperature) && body.temperature >= 0
          ? body.temperature
          : null;

      const models = await fetchModels();
      const fallbackModel = DEFAULT_MODEL || models[0]?.name || "";
      const model = requestedModel || fallbackModel;

      if (!model) {
        json(res, 400, {
          error: "使えるモデルが見つかりません。Ollamaでモデルを追加してください。",
        });
        return;
      }

      if (!messages.length) {
        json(res, 400, {
          error: "送信するメッセージが空です。",
        });
        return;
      }

      const abortController = new AbortController();
      const abortChat = () => {
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      };

      req.once("aborted", abortChat);
      res.once("close", abortChat);

      try {
        if (outputMode === "progressive") {
          let streamOpened = false;

          const openProgressiveStream = () => {
            if (streamOpened || res.writableEnded || res.destroyed) {
              return;
            }

            res.writeHead(200, {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Cache-Control": "no-store",
            });
            res.flushHeaders?.();
            streamOpened = true;
          };

          await streamChatWithOllama({
            model,
            messages,
            profileSystemPrompt,
            systemPrompt,
            customPrompt,
            temperature,
            contextWindow,
            signal: abortController.signal,
            onStart: ({ model: streamingModel }) => {
              openProgressiveStream();
              writeNdjson(res, {
                type: "start",
                model: streamingModel,
              });
            },
            onDelta: ({ model: streamingModel, content }) => {
              openProgressiveStream();
              writeNdjson(res, {
                type: "delta",
                model: streamingModel,
                content,
              });
            },
            onThinkingDelta: ({ model: streamingModel, content }) => {
              openProgressiveStream();
              writeNdjson(res, {
                type: "thinking-delta",
                model: streamingModel,
                content,
              });
            },
            onDone: ({ model: streamingModel, reply, thought, doneReason }) => {
              openProgressiveStream();
              writeNdjson(res, {
                type: "done",
                model: streamingModel,
                reply,
                thought,
                doneReason: typeof doneReason === "string" ? doneReason : "",
              });
            },
          });

          if (!res.writableEnded && !res.destroyed) {
            res.end();
          }
          return;
        }

        const result = await chatWithOllama({
          model,
          messages,
          profileSystemPrompt,
          systemPrompt,
          customPrompt,
          temperature,
          contextWindow,
          signal: abortController.signal,
        });

        if (!res.writableEnded && !res.destroyed && !abortController.signal.aborted) {
          json(res, 200, {
            model,
            reply: result.reply,
            thought: result.thought,
            doneReason: typeof result.doneReason === "string" ? result.doneReason : "",
          });
        }
      } catch (error) {
        if (isAbortError(error)) {
          if (outputMode === "progressive" && res.headersSent && !res.writableEnded && !res.destroyed) {
            res.end();
          }
          return;
        }

        if (outputMode === "progressive" && res.headersSent && !res.writableEnded && !res.destroyed) {
          writeNdjson(res, {
            type: "error",
            error: error instanceof Error ? error.message : "不明なエラーが発生しました。",
          });
          res.end();
          return;
        }

        throw error;
      }
      return;
    }

    if (req.method === "POST" && req.url === "/api/system/create") {
      const body = await readJson(req);
      const baseModel = normalizeModelName(typeof body.baseModel === "string" ? body.baseModel.trim() : "");
      const rawDerivedModelName =
        typeof body.derivedModelName === "string" ? body.derivedModelName.trim() : "";
      const derivedModelName = normalizeModelName(rawDerivedModelName);
      const profile = normalizeSystemProfile(body.profile);
      const systemPrompt = buildSystemPrompt(profile);
      const overwrite = body.overwrite === true;

      if (!baseModel) {
        json(res, 400, { error: "ベースモデルを選択してください。" });
        return;
      }

      if (!derivedModelName) {
        json(res, 400, { error: "派生モデル名を入力してください。" });
        return;
      }

      if (!SYSTEM_MODEL_NAME_PATTERN.test(rawDerivedModelName)) {
        json(res, 400, {
          error: "派生モデル名は英数字と . _ - のみで入力してください。タグは自動で latest になります。",
        });
        return;
      }

      if (!systemPrompt) {
        json(res, 400, {
          error: "固定SYSTEMが空です。少なくとも1項目は入力してください。",
        });
        return;
      }

      const models = await fetchModels();
      const hasBaseModel = models.some((model) => model.name === baseModel);
      if (!hasBaseModel) {
        json(res, 400, {
          error: `ベースモデルが見つかりません: ${baseModel}`,
        });
        return;
      }

      const hasDuplicateModel = models.some((model) => model.name === derivedModelName);
      if (hasDuplicateModel && !overwrite) {
        json(res, 409, {
          error: `同名のモデルがすでに存在します: ${derivedModelName}`,
          duplicate: true,
          existingModel: derivedModelName,
        });
        return;
      }

      if (hasDuplicateModel && overwrite) {
        await deleteOllamaModel(derivedModelName);
      }

      const result = await createDerivedModel({
        baseModel,
        derivedModelName,
        systemPrompt,
      });

      json(res, 200, {
        baseModel,
        model: derivedModelName,
        status: typeof result?.status === "string" ? result.status : "success",
        overwritten: hasDuplicateModel && overwrite,
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/system/delete") {
      const body = await readJson(req);
      const rawName = typeof body.model === "string" ? body.model.trim() : "";

      if (!rawName) {
        json(res, 400, { error: "削除するモデル名を指定してください。" });
        return;
      }

      const modelName = normalizeModelName(rawName);

      const models = await fetchModels();
      const exists = models.some((model) => model.name === modelName);
      if (!exists) {
        json(res, 404, { error: `モデルが見つかりません: ${modelName}` });
        return;
      }

      await deleteOllamaModel(modelName);
      json(res, 200, { model: modelName, status: "deleted" });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    if (res.writableEnded || res.destroyed) {
      return;
    }

    json(res, 500, {
      error:
        error instanceof Error
          ? error.message
          : "不明なエラーが発生しました。",
    });
  }
});

server.on("error", (error) => {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "EADDRINUSE") {
      console.error(`起動ポート ${PORT} は使用中です。接続先設定で別のポートを保存してから再起動してください。`);
      process.exitCode = 1;
      return;
    }

    if (error.code === "EACCES") {
      console.error(`起動ポート ${PORT} を使う権限がありません。別のポートを指定してください。`);
      process.exitCode = 1;
      return;
    }
  }

  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Local AI chat: http://${HOST}:${PORT}`);
  console.log(`Ollama API: ${OLLAMA_URL}`);
  if (AUTO_OPEN_BROWSER) {
    openBrowser();
  }
});
